"""Download one Beam volume file over HTTPS from a worker sandbox."""

import argparse
import hashlib
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit


def write_download(destination: Path, chunks, *, expected_hash=None, expected_size=None) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    stream = tempfile.NamedTemporaryFile(dir=destination.parent, delete=False)
    temporary = Path(stream.name)
    try:
        with stream:
            for chunk in chunks:
                stream.write(chunk)
                digest.update(chunk)
                size += len(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        actual_hash = digest.hexdigest()
        if expected_size is not None and size != expected_size:
            raise ValueError(f"Incomplete download ({size} of {expected_size} bytes)")
        if expected_hash is not None and actual_hash != expected_hash:
            raise ValueError("Downloaded bytes do not match the expected SHA-256")
        os.replace(temporary, destination)
        return size, actual_hash
    finally:
        temporary.unlink(missing_ok=True)


def download(source: str, destination: Path, *, expected_hash=None, context="default") -> tuple[int, str]:
    import requests
    from beam.client import settings
    from beta9.channel import ServiceClient, rpc_timeout
    from beta9.clients.volume import CreatePresignedUrlRequest, PresignedUrlMethod
    from beta9.config import get_config_context, set_settings

    url = urlsplit(source)
    if url.scheme != "beam" or not url.netloc or not url.path.strip("/") or url.query or url.fragment:
        raise ValueError("Use beam://VOLUME/path/to/file")
    set_settings(settings)
    with ServiceClient(get_config_context(context)) as service, rpc_timeout(15):
        reply = service.volume.create_presigned_url(CreatePresignedUrlRequest(
            volume_name=url.netloc, volume_path=url.path.lstrip("/"),
            expires=300, method=PresignedUrlMethod.GetObject,
        ))
    if not reply.ok or urlsplit(reply.url).scheme != "https":
        raise ValueError("Beam did not return a signed HTTPS download")
    # Beam's multipart copy uses a local multiprocessing manager socket.
    # A single streaming request needs no local sockets or sandbox exception.
    with requests.get(reply.url, stream=True, timeout=(10, 30), headers={"Accept-Encoding": "identity"}) as response:
        response.raise_for_status()
        length = response.headers.get("Content-Length")
        expected_size = int(length) if length and response.headers.get("Content-Encoding", "identity") == "identity" else None
        return write_download(destination, response.iter_content(chunk_size=1024 * 1024),
                              expected_hash=expected_hash, expected_size=expected_size)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="beam://VOLUME/path/to/file")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--sha256", help="Expected digest from the producing job or receipt")
    parser.add_argument("--context", default="default", help="Beam CLI context to use")
    args = parser.parse_args()
    if args.sha256 is not None and not re.fullmatch(r"[0-9a-fA-F]{64}", args.sha256):
        parser.error("--sha256 must contain 64 hexadecimal digits")
    try:
        size, digest = download(args.source, args.destination,
                                expected_hash=args.sha256.lower() if args.sha256 else None, context=args.context)
    except Exception as error:
        # SDK and HTTP errors can contain the signed URL. Validation errors above
        # are local and use fixed wording.
        print(f"Beam volume download failed ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
    print(f"Downloaded {size} bytes. SHA-256 {digest}")
