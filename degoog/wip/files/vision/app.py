# ct-vision: SigLIP 2 image/text embeddings for clean-titles. Two questions, answered fast from a cache:
#   POST /score {q, urls}  -> how well each image shows the search (0..1, SigLIP's own probability) + timing
#   POST /near  {url, urls} -> the urls ordered by how alike they look to url
# Images are fetched once, embedded once (fp16 on the GPU), kept by address (LRU), so the Images row, the Images tab
# and the preview's related images all reuse the same work. Nothing is stored on disk except the model download.
import asyncio, io, os, time
from collections import OrderedDict
import httpx, torch
from PIL import Image
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from transformers import AutoModel, AutoProcessor

MODEL = os.environ.get("CT_VISION_MODEL", "google/siglip2-so400m-patch14-384")  # strongest open image-text model
dev = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if dev == "cuda" else torch.float32
torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
model = AutoModel.from_pretrained(MODEL, torch_dtype=dtype).to(dev).eval()
proc = AutoProcessor.from_pretrained(MODEL)
scale = model.logit_scale.exp().item()
bias = model.logit_bias.item()
gpu = torch.cuda.get_device_name(0) if dev == "cuda" else ""

class LRU(OrderedDict):
    def __init__(self, n): super().__init__(); self.n = n
    def get1(self, k):
        v = super().get(k)
        if v is not None: self.move_to_end(k)
        return v
    def put(self, k, v):
        self[k] = v; self.move_to_end(k)
        while len(self) > self.n: self.popitem(last=False)

IMG = LRU(40000)   # url -> unit embedding (cpu fp16), or False when the image can't be read
TXT = LRU(4000)    # query -> unit embedding
lock = asyncio.Lock()
http = httpx.AsyncClient(timeout=httpx.Timeout(2.5, connect=1.5), follow_redirects=True, limits=httpx.Limits(max_connections=48),
                         headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
app = FastAPI()

async def fetch(url):
    try:
        r = await http.get(url)
        if r.status_code != 200 or len(r.content) > 8_000_000: return None
        im = Image.open(io.BytesIO(r.content)); im.draft("RGB", (448, 448))
        return im.convert("RGB")
    except Exception:
        return None

@torch.inference_mode()
def embed_images(ims):
    out = []
    for i in range(0, len(ims), 32):
        x = proc(images=ims[i:i + 32], return_tensors="pt")["pixel_values"].to(dev, dtype)
        e = model.get_image_features(pixel_values=x)
        out.append(torch.nn.functional.normalize(e.float(), dim=-1).half().cpu())
    return torch.cat(out) if out else torch.empty(0)

@torch.inference_mode()
def embed_text(q):
    t = TXT.get1(q)
    if t is not None: return t
    x = proc(text=[f"a photo of {q.lower()}."], padding="max_length", max_length=64, truncation=True, return_tensors="pt").to(dev)
    e = torch.nn.functional.normalize(model.get_text_features(**x).float(), dim=-1)[0].half().cpu()
    TXT.put(q, e)
    return e

async def ensure(urls, budget):
    # Fetch what isn't cached (in parallel, within the time budget), then embed in one batch on the GPU
    todo = list(dict.fromkeys(u for u in urls if IMG.get1(u) is None))
    if todo:
        tasks = [asyncio.create_task(fetch(u)) for u in todo]
        done, pending = await asyncio.wait(tasks, timeout=budget)
        for t in pending: t.cancel()
        got = [(u, t.result()) for u, t in zip(todo, tasks) if t in done]
        ok = [(u, im) for u, im in got if im is not None]
        for u, im in got:
            if im is None: IMG.put(u, False)
        if ok:
            async with lock:
                embs = await asyncio.to_thread(embed_images, [im for _, im in ok])
            for (u, _), e in zip(ok, embs): IMG.put(u, e)
    return [IMG.get1(u) for u in urls]

@app.get("/health")
async def health():
    return {"ok": True, "device": dev, "gpu": gpu, "model": MODEL, "cached": len(IMG)}

@app.post("/score")
async def score(body: dict):
    t0 = time.perf_counter()
    q = str(body.get("q") or "")[:200]
    urls = [str(u)[:2000] for u in (body.get("urls") or [])][:300]
    budget = min(4.0, max(0.3, float(body.get("budget") or 1.5)))
    if not q or not urls: return {"p": [], "ms": 0, "device": dev}
    embs = await ensure(urls, budget)
    async with lock:
        te = await asyncio.to_thread(embed_text, q)
    p = []
    for e in embs:
        if e is None or e is False: p.append(None); continue
        logit = float((e.float() @ te.float()).item()) * scale + bias
        p.append(round(1 / (1 + pow(2.718281828, -logit)), 5))
    return {"p": p, "ms": round((time.perf_counter() - t0) * 1000), "device": dev}

@app.post("/near")
async def near(body: dict):
    t0 = time.perf_counter()
    url = str(body.get("url") or "")[:2000]
    urls = [str(u)[:2000] for u in (body.get("urls") or [])][:300]
    if not url or not urls: return {"sim": [], "ms": 0}
    embs = await ensure([url] + urls, float(body.get("budget") or 1.0))
    a = embs[0]
    sim = [None if (a is None or a is False or e is None or e is False) else round(float((a.float() @ e.float()).item()), 4) for e in embs[1:]]
    return {"sim": sim, "ms": round((time.perf_counter() - t0) * 1000)}

@app.exception_handler(Exception)
async def err(_, e):
    return JSONResponse({"error": type(e).__name__}, status_code=500)
