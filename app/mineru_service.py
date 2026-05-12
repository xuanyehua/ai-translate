import logging
import os
import threading

import httpx

from mineru.cli.api_client import (
    LocalAPIServer,
    build_http_timeout,
    wait_for_local_api_ready,
    find_free_port,
)

logger = logging.getLogger(__name__)

_server: LocalAPIServer | None = None
_base_url: str | None = None
_lock = threading.Lock()


def start() -> str:
    """Start the local MinerU API server and wait until healthy."""
    global _server, _base_url

    with _lock:
        if _server is not None:
            return _base_url  # type: ignore[return-type]

        # Use local models from modelscope (already downloaded)
        os.environ.setdefault("MINERU_MODEL_SOURCE", "modelscope")

        logger.info("Starting local MinerU API server...")
        _server = LocalAPIServer()
        _base_url = _server.start()
        logger.info(f"MinerU API server process started at {_base_url}, waiting for health check...")

    # Wait for the server to be healthy (outside lock, can take time)
    _wait_until_ready()

    return _base_url  # type: ignore[return-type]


def _wait_until_ready():
    """Block until the local MinerU server responds to health checks."""
    import asyncio

    async def _check():
        assert _server is not None
        async with httpx.AsyncClient(timeout=build_http_timeout(), follow_redirects=True) as client:
            await wait_for_local_api_ready(client, _server)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(_check())
    else:
        # We're inside an event loop; spawn a thread to run the check
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(asyncio.run, _check()).result()


def stop():
    """Stop the local MinerU API server."""
    global _server, _base_url
    with _lock:
        if _server is not None:
            logger.info("Stopping local MinerU API server...")
            _server.stop()
            _server = None
            _base_url = None


def get_base_url() -> str:
    """Return the base URL of the running MinerU API server."""
    if _base_url is None:
        raise RuntimeError("MinerU service not started. Call start() first.")
    return _base_url
