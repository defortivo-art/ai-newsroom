"""
광주전남SI뉴스 - AI 자동 취재·송고 엔진 (무료 스택: Groq + 지자체 보도자료 직접 크롤링)

  - LLM : Groq API (openai/gpt-oss-120b)
  - 취재: 지자체 보도자료 게시판(또는 RSS/Atom) 직접 크롤링  -> 검색 엔진 차단과 무관
          (보조) 구글 뉴스 RSS(키 불필요) + DuckDuckGo 웹검색은 크롤링이 안 될 때만 대체 사용
  - 저장: Supabase 'articles' 테이블 (author_type='AI')

흐름
 0) Supabase 'news_sources' 테이블에서 '사용 중'인 취재처 목록을 읽는다
    (관리자 페이지 /admin/sources 에서 관리. 취재처 '주소'에는 보도자료 게시판 목록 주소 또는 RSS 주소를 넣는다)
 1) 취재처 게시판에서 최신 보도자료 N건(기본 3건)의 본문을 즉시 수집 (이미 송고한 것은 건너뜀)
 2) 보도자료 1건당 기사 1건: 취재기자 발제 -> 초안 -> 편집국장 데스킹 루프 -> JSON 확정
 3) 'articles' 에 insert, 취재처 테이블에 마지막 실행 결과 기록

실행:
    python engine.py                    # 사용 중인 모든 취재처 (취재처당 최신 3건)
    python engine.py --count 1          # 취재처당 1건만
    python engine.py --id 3             # 특정 취재처(id)만 (여러 번 지정 가능)
    python engine.py --region 해남군    # 특정 지역의 취재처만
    python engine.py --list             # 등록된 취재처 목록 확인
    python engine.py --dry-run          # DB에 저장하지 않고 결과만 출력(테스트)
    python engine.py --force            # 이미 송고한 보도자료도 다시 작성

필요한 .env:  GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
(Supabase 값은 기사를 DB에 저장하기 위해 필요합니다. AI 쪽 키는 GROQ_API_KEY 하나뿐입니다.)
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import warnings
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable, Optional, TypeVar
from urllib.parse import quote, urljoin, urlparse
from zoneinfo import ZoneInfo

# duckduckgo_search 가 'ddgs' 로 이름이 바뀌었다는 안내 경고를 숨긴다. (import 보다 먼저 설정)
warnings.filterwarnings("ignore", message=r".*renamed to.*ddgs.*", category=RuntimeWarning)

import httpx
from dotenv import load_dotenv
from groq import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    BadRequestError,
    Groq,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
)
from pydantic import BaseModel, Field, ValidationError
from supabase import Client, create_client

try:  # 크롤링이 불가능할 때만 쓰는 대체 수단(없어도 동작)
    from duckduckgo_search import DDGS
except ImportError:  # pragma: no cover
    try:
        from ddgs import DDGS  # type: ignore
    except ImportError:
        DDGS = None  # type: ignore

# --------------------------------------------------------------------------
# 설정
# --------------------------------------------------------------------------
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv()  # backend/.env 가 있으면 보조로 로드

MODEL = os.getenv("GROQ_MODEL", "").strip() or "openai/gpt-oss-120b"
IS_REASONING_MODEL = MODEL.startswith("openai/gpt-oss")

# news_sources 테이블이 비어있거나 아직 없을 때 사용하는 기본 취재처 (보도자료 게시판 주소)
FALLBACK_SOURCES = [
    ("해남군청 보도자료", "해남군", "https://www.haenam.go.kr/index.9is?contentUid=18e3368f5d745106015d877ab2850a94"),
    ("목포시청 보도자료", "목포시", "https://www.mokpo.go.kr/www/mokpo_news/press_release/report_material"),
]

CATEGORIES = ["정치/행정", "경제/산업", "사회/지역", "문화/라이프"]
ITEMS_PER_SOURCE = 3         # 취재처당 가져올 최신 보도자료 수
MAX_CANDIDATES = 10          # 한 취재처에서 상세 페이지를 열어볼 최대 글 수
MAX_AGE_DAYS = 14            # 게시일이 이보다 오래된 글은 '최신'이 아니므로 제외
MIN_BODY_CHARS = 150         # 본문이 이보다 짧으면 기사화하지 않음
MAX_BODY_CHARS = 2200        # LLM 에 넘길 본문 최대 글자 (무료 토큰 한도 고려)
MAX_DESK_ROUNDS = 2          # 데스킹 최대 반복 횟수
API_RETRIES = 4
JSON_RETRIES = 2
MAX_WAIT_SECONDS = 90        # 한도 초과(429) 시 최대 대기 시간
KST = ZoneInfo("Asia/Seoul")

# (대체 수단) 검색 방식 설정
SEARCH_RESULTS = 6
SNIPPET_CHARS = 220
FETCH_PAGES = 2
PAGE_CHARS = 1200

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

T = TypeVar("T")


# --------------------------------------------------------------------------
# 데이터 구조
# --------------------------------------------------------------------------
@dataclass
class Source:
    id: Optional[int]
    name: str
    region: str
    url: Optional[str] = None
    keywords: Optional[str] = None


@dataclass
class Candidate:
    """게시판 목록/피드에서 찾은 글 (본문은 아직 안 읽음)"""
    title: str
    url: str
    date: str = ""
    desc: str = ""


@dataclass
class Material:
    """본문까지 수집한 보도자료 1건"""
    title: str
    url: str
    date: str
    body: str


@dataclass
class SearchItem:
    title: str
    url: str
    snippet: str
    date: str = ""
    origin: str = ""        # 'web' | 'news'
    publisher: str = ""
    page_text: str = ""


@dataclass
class Research:
    items: list[SearchItem] = field(default_factory=list)


class DeskReview(BaseModel):
    approved: bool = Field(description="편집국장이 출고를 승인하면 true")
    score: int = Field(description="0~100 점수")
    feedback: str = Field(description="수정 지시 사항. 승인이면 짧은 총평")


class ArticleDraft(BaseModel):
    title: str = Field(description="헤드라인(40자 이내)")
    subtitle: str = Field(description="부제목(60자 이내)")
    category: str = Field(description="정치/행정, 경제/산업, 사회/지역, 문화/라이프 중 하나")
    content: str = Field(description="본문. 문단은 빈 줄(\\n\\n)로 구분")


# --------------------------------------------------------------------------
# 로그 / 재시도
# --------------------------------------------------------------------------
def log(msg: str) -> None:
    print(f"[{datetime.now(KST).strftime('%H:%M:%S')}] {msg}", flush=True)


class PermanentError(RuntimeError):
    """재시도해도 해결되지 않는 오류(키 오류, 일일 한도 소진, 모델 없음 등)."""


def _retry_after_seconds(err: Exception) -> float:
    try:
        ra = err.response.headers.get("retry-after")  # type: ignore[attr-defined]
        if ra:
            return float(ra)
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r"try again in\s+(?:(\d+)m)?\s*([\d.]+)s", str(err))
    if m:
        return int(m.group(1) or 0) * 60 + float(m.group(2))
    return 15.0


def with_retry(fn: Callable[[], T], label: str) -> T:
    last_err: Optional[Exception] = None
    for attempt in range(1, API_RETRIES + 1):
        try:
            return fn()
        except (AuthenticationError, PermissionDeniedError, NotFoundError) as e:
            raise PermanentError(f"{label}: GROQ_API_KEY/모델명을 확인하세요 -> {e}") from e
        except RateLimitError as e:
            last_err = e
            text = str(e)
            if "per day" in text or "TPD" in text:
                raise PermanentError(
                    f"{label}: Groq 일일 사용 한도를 모두 썼습니다. 내일 다시 실행하세요. ({text[:160]})"
                ) from e
            wait = min(_retry_after_seconds(e) + 1.0, MAX_WAIT_SECONDS)
            log(f"[대기] Groq 분당 한도 도달 -> {wait:.0f}s 후 재시도 ({attempt}/{API_RETRIES})")
            time.sleep(wait)
        except BadRequestError:
            raise  # 요청 형식 문제는 재시도해도 같다 (호출한 쪽에서 처리)
        except (APIConnectionError, APIStatusError) as e:
            last_err = e
            wait = 2 ** attempt
            log(f"[경고] {label} 실패({attempt}/{API_RETRIES}): {e} -> {wait}s 후 재시도")
            time.sleep(wait)
    raise RuntimeError(f"{label} 최종 실패: {last_err}")


# --------------------------------------------------------------------------
# Groq 호출
# --------------------------------------------------------------------------
_json_mode_supported = True  # 모델이 response_format=json_object 를 거부하면 False 로 전환


def chat(
    client: Groq,
    system: str,
    user: str,
    *,
    temperature: float = 0.4,
    max_tokens: int = 1600,
    json_mode: bool = False,
) -> str:
    """Groq 채팅 호출. gpt-oss(추론 모델)는 추론 토큰도 출력 한도에 포함되므로 여유 있게 잡는다."""
    global _json_mode_supported

    def build(limit: int, use_json: bool) -> dict:
        kwargs: dict = {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_completion_tokens": limit,
        }
        if IS_REASONING_MODEL:
            kwargs["reasoning_effort"] = "low"
        if use_json:
            kwargs["response_format"] = {"type": "json_object"}
        return kwargs

    limit = max_tokens + (1200 if IS_REASONING_MODEL else 0)
    text = ""
    for _ in range(2):  # 추론으로 토큰을 다 써서 본문이 비면 한 번 더 넉넉하게 재시도
        use_json = json_mode and _json_mode_supported
        try:
            resp = with_retry(lambda: client.chat.completions.create(**build(limit, use_json)), "Groq 호출")
        except BadRequestError as e:
            if use_json:
                log(f"[안내] 이 모델은 JSON 모드를 지원하지 않아 프롬프트 기반 JSON 으로 전환합니다: {str(e)[:80]}")
                _json_mode_supported = False
                continue
            raise RuntimeError(f"Groq 요청 오류: {e}") from e
        choice = resp.choices[0]
        text = (choice.message.content or "").strip()
        if text or choice.finish_reason != "length":
            break
        limit *= 2
    return text


def _extract_json(text: str) -> str:
    """응답에서 JSON 객체 부분만 꺼낸다 (코드블록·앞뒤 설명 제거)."""
    m = re.search(r"\{.*\}", text, re.S)
    return m.group(0) if m else text


def chat_json(
    client: Groq,
    system: str,
    user: str,
    schema: type[BaseModel],
    *,
    temperature: float = 0.2,
    max_tokens: int = 1600,
):
    """JSON 호출 + pydantic 검증. 형식이 틀리면 오류를 알려주고 재시도한다."""
    keys = ", ".join(schema.model_fields.keys())
    system_json = (
        f"{system}\n\n반드시 JSON 객체 하나만 출력한다. 키: {keys}. "
        "JSON 이외의 설명, 코드블록, 주석은 출력하지 않는다."
    )
    prompt = user
    last_err = ""
    for attempt in range(1, JSON_RETRIES + 2):
        try:
            text = chat(client, system_json, prompt, temperature=temperature, max_tokens=max_tokens, json_mode=True)
            return schema.model_validate_json(_extract_json(text))
        except (ValidationError, ValueError, RuntimeError) as e:
            last_err = str(e)[:300]
        log(f"[경고] JSON 형식 오류 -> 재시도 {attempt}/{JSON_RETRIES + 1}: {last_err[:100]}")
        prompt = f"{user}\n\n(이전 출력이 JSON 형식 오류였다: {last_err}. 키 이름과 타입을 정확히 지켜 다시 출력하라.)"
    raise RuntimeError(f"JSON 응답 생성 실패: {last_err}")


def check_groq(client: Groq) -> None:
    """실행 전에 API 키와 모델 사용 가능 여부를 점검한다."""
    try:
        ids = [m.id for m in client.models.list().data]
    except AuthenticationError:
        sys.exit("GROQ_API_KEY 가 올바르지 않습니다. .env 를 확인하세요. (https://console.groq.com/keys)")
    except Exception as e:  # noqa: BLE001
        log(f"[경고] Groq 모델 목록 확인 실패(계속 진행): {e}")
        return

    if MODEL not in ids:
        log(f"[오류] 모델 '{MODEL}' 을(를) 사용할 수 없습니다. 사용 가능한 모델:")
        for mid in sorted(i for i in ids if "llama" in i or "gpt" in i or "qwen" in i):
            log(f"   - {mid}")
        sys.exit(".env 에 GROQ_MODEL=<위 모델명 중 하나> 를 추가한 뒤 다시 실행하세요.")
    log(f"사용 모델: {MODEL}")


# --------------------------------------------------------------------------
# HTTP / HTML 유틸
# --------------------------------------------------------------------------
def http_get(url: str, timeout: float = 15.0) -> Optional[httpx.Response]:
    for attempt in (1, 2):
        try:
            r = httpx.get(
                url,
                headers={"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9"},
                timeout=timeout,
                follow_redirects=True,
            )
            if r.status_code == 200:
                return r
            if r.status_code in (403, 404, 410):
                return None
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.0)
    return None


def decode_response(r: httpx.Response) -> str:
    """한국 공공기관 사이트는 EUC-KR(CP949) 인 경우가 있어 인코딩을 직접 판별한다."""
    raw = r.content
    ctype = r.headers.get("content-type", "").lower()
    head = raw[:3000].lower()
    if "euc-kr" in ctype or b"euc-kr" in head or b"ks_c_5601" in head:
        return raw.decode("cp949", errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp949", errors="replace")


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "title", "head"}

    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):  # noqa: ANN001
        if tag in self.SKIP:
            self._skip_depth += 1

    def handle_endtag(self, tag):  # noqa: ANN001
        if tag in self.SKIP and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):  # noqa: ANN001
        if self._skip_depth == 0:
            t = data.strip()
            if t:
                self.parts.append(t)


def html_to_text(raw_html: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(raw_html)
    except Exception:  # noqa: BLE001
        pass
    text = html.unescape(" ".join(parser.parts))
    return re.sub(r"\s+", " ", text).strip()


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def _short_date(raw: str) -> str:
    m = re.match(r"(\d{4}-\d{2}-\d{2})", raw or "")
    return m.group(1) if m else ""


DATE_RE = re.compile(r"(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})")


def find_date(text: str) -> str:
    m = DATE_RE.search(text or "")
    if not m:
        return ""
    y, mo, d = (int(x) for x in m.groups())
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return ""
    return f"{y:04d}-{mo:02d}-{d:02d}"


def age_days(date_str: str) -> Optional[int]:
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        return None
    return (datetime.now(KST).date() - d).days


# --------------------------------------------------------------------------
# 취재 방식 1 (기본): 지자체 보도자료 게시판 / RSS 직접 크롤링
# --------------------------------------------------------------------------
NOISE_TITLE = re.compile(r"페이지|이동|다음|이전|목록|처음|마지막|새창|바로가기|다운로드|더보기|검색")
TITLE_TAIL = re.compile(r"\s*(?:NEW|새로운글|새\s*글|N)\b.*$")
VIEW_HINT = re.compile(r"view|read|detail|idx=|nttId=|seq=|articleNo=|bbsNo=|dataUid=|[?&]no=|[?&]id=", re.I)
FOOTER_MARKERS = (
    "이전글", "다음글", "목록으로", "목록 보기", "개인정보처리방침", "개인정보 처리방침",
    "COPYRIGHT", "Copyright", "만족도", "이 페이지에서 제공하는 정보",
)


def _strip_session(url: str) -> str:
    return re.sub(r";jsessionid=[^?&#]*", "", url, flags=re.I)


def looks_like_feed(text: str) -> bool:
    head = text.lstrip()[:300].lower()
    return head.startswith("<?xml") and ("<rss" in head or "<feed" in head or "<rdf" in head) or head.startswith(("<rss", "<feed"))


def parse_feed(xml_text: str) -> list[Candidate]:
    """RSS 2.0 / Atom 피드에서 글 목록을 꺼낸다."""
    out: list[Candidate] = []
    try:
        root = ET.fromstring(xml_text.encode("utf-8", errors="replace"))
    except ET.ParseError:
        return out

    def local(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    for el in root.iter():
        if local(el.tag) not in ("item", "entry"):
            continue
        fields: dict[str, str] = {}
        link = ""
        for ch in el:
            name = local(ch.tag)
            if name == "link":
                link = ch.attrib.get("href") or (ch.text or "").strip() or link
            else:
                fields.setdefault(name, (ch.text or "").strip())
        title = _clean(fields.get("title", ""))
        raw_date = fields.get("pubDate") or fields.get("published") or fields.get("updated") or fields.get("date") or ""
        date = ""
        try:
            date = parsedate_to_datetime(raw_date).astimezone(KST).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            date = _short_date(raw_date) or find_date(raw_date)
        desc = _clean(fields.get("description") or fields.get("summary") or fields.get("encoded") or fields.get("content") or "")
        if title and link:
            out.append(Candidate(title=title, url=link, date=date, desc=desc))
    return out


def extract_board_links(page_html: str, base_url: str) -> list[Candidate]:
    """게시판 목록 HTML 에서 '글 보기' 링크를 찾는다.

    같은 사이트이면서 게시판과 같은 경로(또는 같은 디렉터리)의 view/idx 계열 링크만 고른다.
    (메뉴, 다른 서비스, 페이지 이동, 파일 다운로드 링크는 제외)
    """
    base = urlparse(base_url)
    base_path = base.path.split(";")[0]
    base_dir = base_path.rsplit("/", 1)[0]
    out: list[Candidate] = []
    seen: set[str] = set()

    for m in re.finditer(r"<a\b[^>]*?href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", page_html, flags=re.S | re.I):
        href = html.unescape(m.group(1)).strip()
        if href.startswith(("javascript:", "#", "mailto:", "tel:")):
            continue
        title = TITLE_TAIL.sub("", _clean(m.group(2))).strip()
        if len(title) < 6 or NOISE_TITLE.search(title):
            continue
        absolute = _strip_session(urljoin(base_url, href))
        u = urlparse(absolute)
        if u.netloc != base.netloc or not u.query or "mode=list" in absolute:
            continue
        path = u.path.split(";")[0]
        if not (path == base_path or path.rsplit("/", 1)[0] == base_dir):
            continue
        if not VIEW_HINT.search(absolute):
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        out.append(Candidate(title=title, url=absolute))
    return out


def find_press_links(page_html: str, base_url: str) -> list[str]:
    """메인 페이지 등에서 '보도자료' 메뉴 링크 후보를 찾는다. (하위 메뉴일수록 실제 게시판일 가능성이 높아 먼저)"""
    base_host = urlparse(base_url).netloc
    found: list[str] = []
    for m in re.finditer(r"<a\b[^>]*?href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", page_html, flags=re.S | re.I):
        text = _clean(m.group(2))
        if "보도자료" not in text or re.search(r"이전|지난|설명|팩트|더보기|검색", text) and text != "보도자료":
            continue
        href = html.unescape(m.group(1)).strip()
        if href.startswith(("javascript:", "#")):
            continue
        absolute = _strip_session(urljoin(base_url, href))
        if urlparse(absolute).netloc == base_host and absolute not in found:
            found.append(absolute)
    return sorted(found, key=lambda u: len(urlparse(u).path), reverse=True)[:4]


def crawl_candidates(list_url: str) -> list[Candidate]:
    """취재처 주소(게시판 목록 또는 RSS)에서 최신순 글 목록을 가져온다."""
    r = http_get(list_url)
    if r is None:
        log(f"   [경고] 접속 실패: {list_url}")
        return []
    text = decode_response(r)
    if looks_like_feed(text):
        log("   RSS/Atom 피드로 인식")
        return parse_feed(text)

    final_url = _strip_session(str(r.url))
    cands = extract_board_links(text, final_url)
    if not cands:
        # 메인 페이지를 등록한 경우: '보도자료' 메뉴 링크를 따라가며 글 목록이 나오는 페이지를 찾는다
        for link in find_press_links(text, final_url):
            if link == final_url:
                continue
            log(f"   '보도자료' 메뉴 확인: {link}")
            r2 = http_get(link)
            if r2 is None:
                continue
            t2 = decode_response(r2)
            cands = parse_feed(t2) if looks_like_feed(t2) else extract_board_links(t2, _strip_session(str(r2.url)))
            if cands:
                break
    return cands


def fetch_material(c: Candidate) -> Optional[Material]:
    """글 상세 페이지를 열어 제목·게시일·본문을 추출한다."""
    r = http_get(c.url)
    body, date, title = "", c.date, c.title
    if r is not None:
        raw_html = decode_response(r)
        text = html_to_text(raw_html)

        # 본문은 '제목이 처음 나오는 지점'부터 (메뉴/내비게이션 텍스트 제거)
        key = c.title[:12]
        idx = text.find(key) if key else -1
        seg = text[idx:] if idx >= 0 else text

        # 하단 안내문(이전글/다음글/저작권 등) 제거
        cut = len(seg)
        for mk in FOOTER_MARKERS:
            p = seg.find(mk, 150)
            if p != -1:
                cut = min(cut, p)
        seg = seg[:cut]

        date = date or find_date(seg[:500]) or find_date(seg)
        body = seg[:MAX_BODY_CHARS]

        # 상세 페이지 제목이 목록 제목(잘린 경우 포함)을 확장해 주면 그것을 사용
        mt = re.search(r"<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)", raw_html, re.I)
        detail_title = _clean(mt.group(1)) if mt else ""
        if detail_title and detail_title.startswith(c.title[:8]) and len(detail_title) > len(title):
            title = detail_title
    elif c.desc:
        body = c.desc[:MAX_BODY_CHARS]

    if len(body) < MIN_BODY_CHARS:
        return None
    return Material(title=title.rstrip("."), url=c.url, date=date, body=body)


def already_published(supabase: Client, url: str) -> bool:
    """기사 하단 '참고 출처'에 이 보도자료 주소가 이미 들어 있으면 송고된 것으로 본다."""
    try:
        res = supabase.table("articles").select("id").ilike("content", f"%{url}%").limit(1).execute()
        return bool(res.data)
    except Exception as e:  # noqa: BLE001
        log(f"   [경고] 중복 확인 실패(계속 진행): {e}")
        return False


def collect_press_releases(
    src: Source,
    count: int,
    supabase: Optional[Client],
    force: bool,
) -> tuple[list[Material], int]:
    """(수집한 보도자료, 게시판에서 발견한 글 수) 를 돌려준다. 글 수가 0이면 게시판 접근/해석 실패."""
    if not src.url:
        return [], 0
    cands = crawl_candidates(src.url)
    if not cands:
        return [], 0
    log(f"   게시판에서 글 {len(cands)}건 발견 -> 최신 {count}건 수집")

    out: list[Material] = []
    skipped = stale = 0
    for c in cands[:MAX_CANDIDATES]:
        if len(out) >= count:
            break
        if supabase is not None and not force and already_published(supabase, c.url):
            skipped += 1
            continue
        m = fetch_material(c)
        if m is None:
            continue
        age = age_days(m.date) if m.date else None
        if age is not None and age > MAX_AGE_DAYS:
            stale += 1
            continue
        log(f"   - [{m.date or '날짜미상'}] {m.title[:50]} ({len(m.body)}자)")
        out.append(m)
        time.sleep(0.5)  # 지자체 서버 부담 완화
    if skipped:
        log(f"   (이미 송고한 보도자료 {skipped}건 건너뜀)")
    if stale:
        log(f"   (게시일이 {MAX_AGE_DAYS}일보다 오래된 글 {stale}건 제외)")
    return out, len(cands)


def build_fact_sheet(m: Material, src: Source) -> str:
    """보도자료 원문 자체가 팩트의 근거다. (LLM 요약을 거치지 않아 왜곡과 토큰 낭비를 줄인다)"""
    return (
        "[보도자료 원문]\n"
        f"- 출처기관: {src.region} ({src.name})\n"
        f"- 제목: {m.title}\n"
        f"- 게시일: {m.date or '확인 불가'}\n"
        f"- 원문 주소: {m.url}\n"
        f"- 본문:\n{m.body}"
    )


# --------------------------------------------------------------------------
# 취재 방식 2 (대체): 구글 뉴스 RSS(제목/날짜/매체) + DuckDuckGo 웹검색
#   - 네이버 검색 RSS 는 현재 403 으로 막혀 있어 키 없이 열리는 구글 뉴스 RSS 를 사용한다.
#   - 구글 뉴스 RSS 는 본문을 주지 않으므로 '최신성 확인용'으로만 쓴다.
# --------------------------------------------------------------------------
def google_news_items(region: str, terms: str, limit: int = SEARCH_RESULTS) -> list[SearchItem]:
    query = f"{region} {terms} when:14d"
    url = f"https://news.google.com/rss/search?q={quote(query)}&hl=ko&gl=KR&ceid=KR:ko"
    r = http_get(url)
    if r is None:
        return []
    items: list[SearchItem] = []
    try:
        root = ET.fromstring(r.content)
    except ET.ParseError:
        return []
    for it in root.findall("./channel/item")[:limit]:
        title = _clean(it.findtext("title") or "")
        publisher = _clean(it.findtext("source") or "")
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3]
        date = ""
        try:
            date = parsedate_to_datetime(it.findtext("pubDate") or "").astimezone(KST).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            pass
        items.append(SearchItem(
            title=_clip(title, 90), url=it.findtext("link") or "", snippet="",
            date=date, origin="news", publisher=publisher,
        ))
    return items


def _new_ddgs():
    """DDGS 생성. 라이브러리가 생성자 안에서 경고 필터를 'always' 로 바꾸므로 경고를 기록만 하게 감싼다."""
    with warnings.catch_warnings(record=True):
        return DDGS()


def _ddg_text(query: str, timelimits: tuple[str, ...] = ("m", "y")) -> list[dict]:
    if DDGS is None:
        return []
    for tl in timelimits:
        for attempt in (1, 2):
            time.sleep(1.5)
            try:
                with _new_ddgs() as ddgs:
                    rows = ddgs.text(query, region="kr-kr", timelimit=tl, max_results=SEARCH_RESULTS)
                if rows:
                    return list(rows)
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    log(f"[경고] DuckDuckGo 검색 포기({type(e).__name__}) -> 건너뜁니다")
                    return []
                log(f"[경고] DuckDuckGo 검색 실패({type(e).__name__}) -> 8s 후 재시도")
                time.sleep(8)
    return []


def _clip(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", (s or "")).strip()
    return s if len(s) <= n else s[:n].rstrip() + "…"


def fetch_page_text(url: str, max_chars: int = PAGE_CHARS) -> str:
    r = http_get(url, timeout=8.0)
    if r is None or "html" not in r.headers.get("content-type", "").lower():
        return ""
    return html_to_text(decode_response(r))[:max_chars]


def _region_stem(region: str) -> str:
    stem = re.sub(r"(특별자치도|특별자치시|광역시|특별시|군|시|도)$", "", region.strip())
    return stem if len(stem) >= 2 else region.strip()


def _host_of(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.") if url else ""


def research_source(src: Source) -> Research:
    """대체 취재: 구글 뉴스 RSS 헤드라인 + DuckDuckGo 웹검색(+상위 페이지 본문)."""
    terms = (src.keywords or "보도자료").replace(",", " ").strip()
    host = _host_of(src.url) if src.url else ""
    stem = _region_stem(src.region)

    items: list[SearchItem] = []
    seen: set[str] = set()
    dropped = 0

    def add(item: SearchItem) -> None:
        nonlocal dropped
        key = item.url.split("#")[0]
        if not key or key in seen:
            return
        blob = f"{item.title} {item.snippet} {item.url}"
        if not ((host and _host_of(item.url).endswith(host)) or stem in blob):
            dropped += 1
            return
        seen.add(key)
        items.append(item)

    for q in (f"{src.region} {terms}", f"{src.region} {src.name}"):
        for r in _ddg_text(q):
            add(SearchItem(
                title=_clip(r.get("title", ""), 80), url=r.get("href", ""),
                snippet=_clip(r.get("body", ""), SNIPPET_CHARS), origin="web",
            ))
        if sum(1 for i in items if i.origin == "web") >= 3:
            break

    for it in google_news_items(src.region, " ".join(terms.split()[:3]) or "보도자료"):
        add(it)

    if dropped:
        log(f"   (지역과 무관한 검색 결과 {dropped}건 제외)")

    # 상위 웹 페이지 본문 읽기 (구글 뉴스 링크는 JS 리다이렉트라 읽을 수 없으므로 제외)
    fetched = 0
    for item in [i for i in items if i.origin == "web"]:
        if fetched >= FETCH_PAGES:
            break
        text = fetch_page_text(item.url)
        if len(text) >= 200:
            item.page_text = text
            fetched += 1
    return Research(items=items)


def format_research(research: Research) -> str:
    lines: list[str] = []
    for n, it in enumerate(research.items, 1):
        head = f"[{n}] ({'뉴스헤드라인' if it.origin == 'news' else '웹'}) {it.title}"
        meta = [f"날짜: {it.date}" if it.date else "날짜: 미상"]
        if it.publisher:
            meta.append(f"매체: {it.publisher}")
        if it.origin == "web":
            meta.append(f"URL: {it.url}")
        lines.append(f"{head}\n    {' | '.join(meta)}")
        if it.snippet:
            lines.append(f"    요약: {it.snippet}")
        if it.page_text:
            lines.append(f"    본문발췌: {it.page_text}")
    return "\n".join(lines)


def sources_for_publish(research: Research, src: Source) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    if src.url:
        out.append({"title": src.name, "uri": src.url})
        seen.add(src.url)
    used = [i for i in research.items if i.page_text and i.origin == "web"] or [
        i for i in research.items if i.origin == "web"
    ][:2]
    for it in used:
        if it.url and it.url not in seen:
            seen.add(it.url)
            out.append({"title": it.title or "출처", "uri": it.url})
    return out


FACT_SYSTEM = (
    "너는 지방자치단체 공고·보도자료를 정리하는 팩트체커다. "
    "오직 아래 [검색 자료]에 적힌 내용만 근거로 삼는다. 자료에 없는 사실, 수치, 날짜는 절대 추가하지 않는다. "
    "자료에 적힌 문장을 그대로 베끼지 말고 사실만 간결하게 재구성한다."
)


def collect_fact_sheet(client: Groq, src: Source, research: Research) -> str:
    today = datetime.now(KST).strftime("%Y년 %m월 %d일")
    prompt = f"""오늘은 {today}이다.
취재처: {src.name} / 지역: {src.region}

[검색 자료]
{format_research(research)}

위 [검색 자료]에서 {src.region} 독자에게 유용한 '최근' 행정 소식을 골라 '팩트 시트'를 작성하라.

[작성 규칙]
- 항목 2~4개, 각 항목: 항목명 / 핵심 내용(1~2문장) / 일시·기간 / 대상·장소 / 문의처(자료에 있을 때만) / 근거 [자료 번호]
- 자료에서 확인되지 않는 정보는 '확인 불가'로 적는다. '뉴스헤드라인' 자료는 제목에 적힌 사실만 쓴다.
- 날짜가 확인되지 않거나 약 1개월 이상 지난 소식은 제외한다.
- 쓸 만한 최근 소식이 전혀 없으면 다른 말 없이 'NO_FACTS' 한 단어만 출력한다.
"""
    return chat(client, FACT_SYSTEM, prompt, temperature=0.1, max_tokens=1100)


# --------------------------------------------------------------------------
# 기사 작성: 취재기자 발제 -> 초안 -> 편집국장 데스킹 루프 -> JSON 확정
# --------------------------------------------------------------------------
REPORTER_SYSTEM = (
    "너는 광주전남SI뉴스 {region} 담당 취재기자다. 육하원칙에 충실한 정통 스트레이트 기사를 쓴다. "
    "팩트 시트(보도자료 원문)에 없는 사실, 수치, 인용문, 인물 발언을 절대 만들어내지 않는다. "
    "보도자료 문장을 그대로 복사하지 말고 기사체로 재구성한다. "
    "문체는 '~했다', '~밝혔다' 등 신문 기사체를 쓰며, 모든 출력은 한국어로 한다."
)

DESK_SYSTEM = (
    "너는 광주전남SI뉴스 편집국장이다. 기사를 엄격히 데스킹한다. 점검 항목: "
    "(1) 팩트 시트에 없는 내용의 창작 여부 (2) 리드 문단의 핵심 전달력 "
    "(3) 헤드라인의 정확성·과장 여부 (4) 기사체 및 문법 (5) 독자 유용성(일시·대상·문의처). "
    "문제가 없으면 approved=true, 하나라도 중대하면 approved=false 와 구체적 수정 지시를 준다. "
    "모든 출력은 한국어로 한다."
)


def reporter_pitch(client: Groq, region: str, fact_sheet: str) -> str:
    prompt = f"""아래 팩트 시트를 바탕으로 편집국장에게 올릴 '발제문'을 작성하라.

[팩트 시트]
{fact_sheet}

[발제문 형식]
- 선정 아이템: (팩트 시트 중 독자에게 가장 유용한 1건)
- 기사 각도(앵글):
- 예상 헤드라인:
- 예상 카테고리: {', '.join(CATEGORIES)} 중 택1
- 선정 이유:
"""
    return chat(client, REPORTER_SYSTEM.format(region=region), prompt, temperature=0.5, max_tokens=500)


def reporter_write(client: Groq, region: str, fact_sheet: str, pitch: str) -> str:
    prompt = f"""승인된 발제문과 팩트 시트를 바탕으로 기사 초안을 작성하라.

[발제문]
{pitch}

[팩트 시트]
{fact_sheet}

[작성 규칙]
- 분량: 본문 600~1,000자
- 첫 문단(리드)에 핵심(누가·무엇을·언제)을 담는다.
- 문단은 빈 줄로 구분한다.
- 팩트 시트에 없는 수치·인용·발언 창작 금지.
- 마지막 문단에 독자가 알아야 할 신청 방법·문의처를 정리한다(확인 불가면 생략).
- 헤드라인, 부제목, 본문 순서로 출력한다.
"""
    return chat(client, REPORTER_SYSTEM.format(region=region), prompt, temperature=0.5, max_tokens=1500)


def desk_review(client: Groq, fact_sheet: str, draft: str) -> DeskReview:
    prompt = f"""[팩트 시트]
{fact_sheet}

[기자 초안]
{draft}

위 초안을 데스킹하라. 승인 기준은 80점 이상이며 사실 왜곡·창작이 없을 때만 approved=true 이다.
출력 JSON 예: {{"approved": false, "score": 72, "feedback": "리드에 일시가 빠졌다. ..."}}"""
    return chat_json(client, DESK_SYSTEM, prompt, DeskReview, temperature=0.1, max_tokens=500)


def reporter_revise(client: Groq, region: str, fact_sheet: str, draft: str, feedback: str) -> str:
    prompt = f"""편집국장의 데스킹 지시를 반영하여 기사를 수정하라.

[팩트 시트]
{fact_sheet}

[현재 초안]
{draft}

[편집국장 지시]
{feedback}

수정된 전체 기사(헤드라인, 부제목, 본문)를 다시 출력하라. 팩트 시트에 없는 내용을 추가하지 마라."""
    return chat(client, REPORTER_SYSTEM.format(region=region), prompt, temperature=0.4, max_tokens=1500)


def desking_loop(client: Groq, region: str, fact_sheet: str, pitch: str) -> str:
    draft = reporter_write(client, region, fact_sheet, pitch)
    for round_no in range(1, MAX_DESK_ROUNDS + 1):
        review = desk_review(client, fact_sheet, draft)
        log(f"   [데스킹 {round_no}회차] 승인={review.approved} 점수={review.score}")
        log(f"      편집국장: {review.feedback[:120]}")
        if review.approved:
            return draft
        if round_no == MAX_DESK_ROUNDS:
            log("   [경고] 최대 데스킹 횟수 도달 -> 마지막 수정본으로 진행")
            break
        draft = reporter_revise(client, region, fact_sheet, draft, review.feedback)
    return draft


def finalize_article(client: Groq, draft: str) -> ArticleDraft:
    system = "너는 편집기자다. 주어진 기사를 지정된 JSON 형식으로만 정리한다. 내용을 새로 만들지 않는다."
    prompt = f"""아래 최종 기사 원고를 JSON으로 정리하라.
- title: 헤드라인(40자 이내, 마침표 없음)
- subtitle: 부제목(60자 이내)
- category: {', '.join(CATEGORIES)} 중 정확히 하나
- content: 본문만(헤드라인·부제목 제외), 문단 사이는 빈 줄(\\n\\n)

[원고]
{draft}
"""
    art = chat_json(client, system, prompt, ArticleDraft, temperature=0.1, max_tokens=1600)
    if art.category not in CATEGORIES:
        art.category = "사회/지역"
    return art


def publish(supabase: Client, src: Source, art: ArticleDraft, sources: list[dict]) -> int:
    body = art.content.strip()
    if sources:
        lines = "\n".join(f"- {s['title']}: {s['uri']}" for s in sources[:5])
        body += f"\n\n[참고 출처]\n{lines}"

    row = {
        "title": art.title.strip(),
        "subtitle": art.subtitle.strip(),
        "category": art.category,
        "author": f"{src.region} AI 가상뉴스룸 취재팀",
        "author_type": "AI",
        "content": body,
    }
    res = supabase.table("articles").insert(row).execute()
    return int(res.data[0]["id"])


def produce_article(
    client: Groq,
    supabase: Optional[Client],
    src: Source,
    fact_sheet: str,
    found_sources: list[dict],
    tag: str,
    dry_run: bool,
) -> Optional[int]:
    """팩트 시트 1개 -> 기사 1건 (발제 -> 데스킹 루프 -> JSON 확정 -> 저장)"""
    log(f"[{tag}] 취재기자 발제...")
    pitch = reporter_pitch(client, src.region, fact_sheet)

    log(f"[{tag}] 편집국장 데스킹 루프")
    final_draft = desking_loop(client, src.region, fact_sheet, pitch)

    log(f"[{tag}] JSON 기사 확정")
    article = finalize_article(client, final_draft)

    if dry_run or supabase is None:
        print("\n" + "=" * 60)
        print(f"[DRY-RUN] {article.category} | {article.title}\n{article.subtitle}\n\n{article.content}")
        print("[출처]", *[f"\n- {s['title']}: {s['uri']}" for s in found_sources[:5]])
        print("=" * 60 + "\n")
        return None

    article_id = publish(supabase, src, article, found_sources)
    log(f"[{tag}] 송고 완료 id={article_id} | {article.title}")
    return article_id


# --------------------------------------------------------------------------
# 취재처 로딩 / 상태 기록
# --------------------------------------------------------------------------
def fallback_sources() -> list[Source]:
    return [Source(id=None, name=n, region=r, url=u) for n, r, u in FALLBACK_SOURCES]


def load_sources(
    supabase: Client,
    ids: list[int],
    regions: list[str],
    include_disabled: bool = False,
) -> list[Source]:
    try:
        query = supabase.table("news_sources").select("*").order("id")
        if not include_disabled:
            query = query.eq("enabled", True)
        rows = query.execute().data or []
    except Exception as e:  # noqa: BLE001
        log(f"[경고] news_sources 테이블을 읽지 못했습니다({e}). supabase_schema.sql 을 실행했는지 확인하세요.")
        rows = []

    sources = [
        Source(
            id=r["id"], name=r["name"], region=r["region"],
            url=(r.get("url") or None), keywords=(r.get("keywords") or None),
        )
        for r in rows
    ]
    if ids:
        sources = [s for s in sources if s.id in ids]
    if regions:
        sources = [s for s in sources if s.region in regions]

    if not rows and not ids and not regions:
        log("[안내] 등록된 취재처가 없어 기본 취재처(해남군·목포시 보도자료)로 진행합니다.")
        sources = fallback_sources()
    return sources


def record_status(
    supabase: Optional[Client],
    src: Source,
    status: str,
    article_id: Optional[int] = None,
) -> None:
    if supabase is None or src.id is None:
        return
    payload: dict = {
        "last_run_at": datetime.now(timezone.utc).isoformat(),
        "last_status": status[:300],
    }
    if article_id is not None:
        payload["last_article_id"] = article_id
    try:
        supabase.table("news_sources").update(payload).eq("id", src.id).execute()
    except Exception as e:  # noqa: BLE001
        log(f"[경고] 취재처 상태 기록 실패: {e}")


# --------------------------------------------------------------------------
# 파이프라인
# --------------------------------------------------------------------------
def run_for_source(
    client: Groq,
    supabase: Optional[Client],
    src: Source,
    count: int,
    dry_run: bool = False,
    force: bool = False,
) -> list[int]:
    tag = f"{src.region}/{src.name}"
    log(f"[{tag}] 보도자료 수집 시작" + (f" ({src.url})" if src.url else " (주소 없음 -> 검색 방식)"))

    # ---- 1순위: 보도자료 게시판/RSS 직접 크롤링 -> 보도자료 1건당 기사 1건 ----
    materials, found = collect_press_releases(src, count, supabase, force)
    if materials:
        ids: list[int] = []
        for n, m in enumerate(materials, 1):
            sub = f"{tag} {n}/{len(materials)}"
            log(f"[{sub}] 기사 작성: {m.title[:50]}")
            try:
                aid = produce_article(
                    client, supabase, src,
                    build_fact_sheet(m, src),
                    [{"title": src.name, "uri": m.url}],
                    sub, dry_run,
                )
            except PermanentError:
                raise
            except Exception as e:  # noqa: BLE001
                log(f"[{sub}] 기사 작성 실패: {e}")
                continue
            if aid:
                ids.append(aid)
        if ids:
            record_status(supabase, src, f"송고 완료 {len(ids)}건 (기사 " + ", ".join(f"#{i}" for i in ids) + ")", ids[-1])
        elif not dry_run:
            record_status(supabase, src, "실패: 기사 작성에 실패했습니다")
        return ids

    # 게시판은 읽었지만 새 글이 없는 경우(이미 송고됨/오래됨)와, 아예 읽지 못한 경우를 구분한다.
    if found > 0:
        log(f"[{tag}] 새로 송고할 최신 보도자료가 없습니다 (이미 송고했거나 {MAX_AGE_DAYS}일 이내 글 없음)")
        record_status(supabase, src, "새 보도자료 없음 (송고 생략)")
        return []

    # ---- 2순위(대체): 구글 뉴스 RSS + DuckDuckGo 검색 -> 기사 1건 ----
    log(f"[{tag}] 게시판에서 가져오지 못해 검색 방식으로 전환합니다")
    research = research_source(src)
    if not research.items:
        log(f"[{tag}] 검색 결과 없음 -> 송고 생략")
        record_status(supabase, src, "수집 실패 (게시판/검색 모두 결과 없음)")
        return []
    log(f"[{tag}] 검색 {len(research.items)}건, 본문 수집 {sum(1 for i in research.items if i.page_text)}건")

    fact_sheet = collect_fact_sheet(client, src, research)
    if not fact_sheet or fact_sheet.strip().strip("'\"") == "NO_FACTS":
        log(f"[{tag}] 확인된 최신 소식 없음 -> 송고 생략")
        record_status(supabase, src, "최신 소식 없음 (송고 생략)")
        return []

    aid = produce_article(client, supabase, src, fact_sheet, sources_for_publish(research, src), tag, dry_run)
    if aid:
        record_status(supabase, src, f"송고 완료 (검색 방식, 기사 #{aid})", aid)
        return [aid]
    return []


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="광주전남SI뉴스 AI 자동 송고 엔진 (Groq + 보도자료 직접 크롤링)")
    p.add_argument("--id", type=int, action="append", default=[], help="실행할 취재처 id (여러 번 지정 가능)")
    p.add_argument("--region", action="append", default=[], help="실행할 지역명 (예: 해남군)")
    p.add_argument("--count", type=int, default=ITEMS_PER_SOURCE, help=f"취재처당 가져올 최신 보도자료 수 (기본 {ITEMS_PER_SOURCE})")
    p.add_argument("--list", action="store_true", help="등록된 취재처 목록만 출력")
    p.add_argument("--dry-run", action="store_true", help="DB에 저장하지 않고 결과만 출력")
    p.add_argument("--force", action="store_true", help="이미 송고한 보도자료도 다시 작성")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    groq_key = os.getenv("GROQ_API_KEY")
    sb_url = os.getenv("SUPABASE_URL")
    sb_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    supabase: Optional[Client] = None
    if sb_url and sb_key:
        supabase = create_client(sb_url, sb_key)
    elif not args.dry_run:
        sys.exit("환경변수 누락: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (기사를 DB에 저장하는 데 필요합니다. .env 확인)")

    if args.list:
        if supabase is None:
            sys.exit("--list 는 Supabase 설정이 필요합니다.")
        for s in load_sources(supabase, [], [], include_disabled=True):
            print(f"#{s.id} [{s.region}] {s.name} | {s.url or '-'} | {s.keywords or '-'}")
        return

    if not groq_key:
        sys.exit("환경변수 누락: GROQ_API_KEY (https://console.groq.com/keys 에서 무료 발급 후 .env 에 입력)")

    client = Groq(api_key=groq_key, max_retries=0, timeout=90.0)
    check_groq(client)

    sources = load_sources(supabase, args.id, args.region) if supabase else fallback_sources()
    if not sources:
        sys.exit("실행할 취재처가 없습니다. 관리자 페이지(/admin/sources)에서 취재처를 추가/활성화하세요.")
    count = max(1, args.count)
    log(f"실행 대상 취재처 {len(sources)}곳 x 최신 {count}건" + (" [DRY-RUN]" if args.dry_run else ""))

    published: list[int] = []
    for src in sources:
        try:
            published.extend(run_for_source(client, supabase, src, count, dry_run=args.dry_run, force=args.force))
        except PermanentError as e:
            log(f"[중단] {e}")
            record_status(supabase, src, f"실패: {e}")
            break
        except Exception as e:  # noqa: BLE001
            log(f"[{src.region}/{src.name}] 처리 실패: {e}")
            record_status(supabase, src, f"실패: {e}")

    log(f"종료. 송고 {len(published)}건: {published}")


if __name__ == "__main__":
    main()
