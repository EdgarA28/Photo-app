"""A seekable, read-only file over one S3 object, read with ranged GETs (spec §10.2, 14.3).

FFmpeg (PyAV) only reads what it needs from a video: the container's index (`moov`, often at the
end of phone videos) and the frames around the poster. Reading through this file means a 2 GB
video costs a few MB of GETs instead of a 2 GB download or `/tmp` space.

Each read is pinned to the ETag that was checked before (`IfMatch`): if the object changes
while it is read, S3 answers 412 and the error is raised as transient (the next attempt reads
the new bytes consistently). Any S3 error raised here comes out of PyAV unchanged.
"""

import io
from typing import Any

# Most bytes one video may make us read; beyond it the file is treated as unreadable (a broken
# index could otherwise make FFmpeg scan the whole 2 GB).
MAX_READ_BYTES = 256 * 1024 * 1024


class ReadLimitExceeded(Exception):
    """Reading the video needed more than `max_bytes`: permanent."""


class S3RangeFile(io.RawIOBase):
    def __init__(
        self,
        s3: Any,
        bucket: str,
        key: str,
        size: int,
        etag: str,
        max_bytes: int = MAX_READ_BYTES,
    ) -> None:
        super().__init__()
        self._s3 = s3
        self._bucket = bucket
        self._key = key
        self._size = size
        self._etag = etag
        self._max_bytes = max_bytes
        self._pos = 0
        self.bytes_read = 0
        self.requests = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            pos = offset
        elif whence == io.SEEK_CUR:
            pos = self._pos + offset
        elif whence == io.SEEK_END:
            pos = self._size + offset
        else:
            raise ValueError(f"invalid whence: {whence}")
        if pos < 0:
            raise ValueError("negative seek position")
        self._pos = pos
        return pos

    def readinto(self, buffer: Any) -> int:
        view = memoryview(buffer).cast("B")
        if self._pos >= self._size or len(view) == 0:
            return 0
        end = min(self._pos + len(view), self._size)  # exclusive
        if self.bytes_read + (end - self._pos) > self._max_bytes:
            raise ReadLimitExceeded(f"reading needs more than {self._max_bytes} bytes")
        response = self._s3.get_object(
            Bucket=self._bucket,
            Key=self._key,
            Range=f"bytes={self._pos}-{end - 1}",
            IfMatch=self._etag,
        )
        self.requests += 1
        data = response["Body"].read()
        n = len(data)
        view[:n] = data
        self._pos += n
        self.bytes_read += n
        return n
