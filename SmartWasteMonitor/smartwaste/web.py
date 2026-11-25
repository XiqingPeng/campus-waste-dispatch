from contextlib import asynccontextmanager
import secrets
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware


class CameraChoice(BaseModel):
    index: int | None = Field(default=None, ge=0, le=15)


class SourceEpoch(BaseModel):
    device: str = Field(min_length=1, max_length=100)
    epoch: int = Field(ge=0)


class CalibrationInput(SourceEpoch):
    label: str = Field(pattern=r"^\S(?:[^\n\r]{0,78}\S)?$", max_length=80)
    regions: dict[str, list[tuple[float, float]]]


class ReplayInput(BaseModel):
    action: Literal["pause", "resume", "restart"]


class ReviewInput(BaseModel):
    status: Literal["suspected", "confirmed", "rejected"]
    category: Literal["可回收物", "厨余垃圾", "有害垃圾", "其他垃圾", "无法判断"] | None = None


def create_app(monitor, static, *, start_worker=True):
    token = secrets.token_urlsafe(32)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if start_worker:
            monitor.start()
        try:
            yield
        finally:
            if start_worker:
                monitor.stop()

    app = FastAPI(title="Smart Waste Monitoring", lifespan=lifespan, docs_url=None,
                  redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
    app.mount("/static", StaticFiles(directory=static), name="static")

    @app.middleware("http")
    async def browser_headers(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        return response

    def local_action(x_monitor_token: str = Header(default="")):
        if not secrets.compare_digest(token, x_monitor_token):
            raise HTTPException(403, "页面令牌已失效，请刷新。")

    def action(call, *args):
        try:
            return call(*args)
        except ValueError as err:
            raise HTTPException(400, str(err)) from err

    @app.get("/")
    def main_page():
        return FileResponse(static / "index.html")

    @app.get("/api/session")
    def get_session():
        return {"token": token}

    @app.get("/api/state")
    def get_state():
        return monitor.snapshot()

    @app.get("/api/history")
    def history():
        return {"drops": monitor.store.drop_rows(), "fullness": monitor.store.full_rows()}

    @app.get("/api/frame.jpg")
    def frame():
        with monitor.lock:
            img = monitor.preview
        if img is None:
            return Response(status_code=204)
        return Response(img, media_type="image/jpeg")

    @app.get("/api/photo/{event}/{ordinal}.jpg")
    def event_photo(event: int, ordinal: int):
        file = monitor.store.photo_file(event, ordinal)
        if not file:
            raise HTTPException(404, "照片不存在。")
        return FileResponse(file, media_type="image/jpeg")

    @app.get("/api/reference/{kind}.jpg")
    def reference(kind: Literal["empty", "full"]):
        image = monitor.get_ref(kind)
        return Response(image, media_type="image/jpeg") if image else Response(status_code=204)

    @app.get("/api/export/{kind}.csv")
    def export(kind: Literal["drops", "fullness"]):
        return Response(monitor.store.csv(kind), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{kind}.csv"'})

    @app.post("/api/camera", dependencies=[Depends(local_action)])
    def camera(choice: CameraChoice):
        action(monitor.set_camera, choice.index)
        return {"ok": True}

    @app.post("/api/replay", dependencies=[Depends(local_action)])
    def replay(choice: ReplayInput):
        action(monitor.set_replay, choice.action)
        return {"ok": True}

    @app.post("/api/reference/{kind}", dependencies=[Depends(local_action)])
    def save_reference(kind: Literal["empty", "full"], source: SourceEpoch):
        return {"references": action(monitor.capture_ref, kind, source.device, source.epoch)}

    @app.post("/api/calibrate", dependencies=[Depends(local_action)])
    def save_calibration(source: CalibrationInput):
        version = action(monitor.calibrate, source.device, source.epoch, source.label, source.regions)
        return {"version": version}

    @app.post("/api/manual-capture", dependencies=[Depends(local_action)])
    def manual_capture(source: SourceEpoch):
        return {"id": action(monitor.save_manual, source.device, source.epoch)}

    @app.post("/api/review/{event}", dependencies=[Depends(local_action)])
    def review_event(event: int, decision: ReviewInput):
        if not monitor.store.review(event, decision.status, decision.category):
            raise HTTPException(404, "找不到投放记录。")
        return {"ok": True}

    @app.post("/api/fullness/{event}/cleaned", dependencies=[Depends(local_action)])
    def report_clean(event: int):
        if not monitor.backlog_cleared(event):
            raise HTTPException(404, "该满载事件不存在或已结束。")
        return {"ok": True}

    return app
