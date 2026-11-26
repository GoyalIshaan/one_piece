import hashlib
import tempfile
import unittest
from pathlib import Path

from volume_file import write_download


class VolumeFileTest(unittest.TestCase):
    def test_valid_transfer_writes_the_exact_file(self):
        chunks = [b"output ", b"receipt"]
        digest = hashlib.sha256(b"".join(chunks)).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "result"
            self.assertEqual(write_download(destination, chunks, expected_hash=digest, expected_size=14), (14, digest))
            self.assertEqual(destination.read_bytes(), b"output receipt")

    def test_transfer_errors_leave_the_verified_destination_intact(self):
        def interrupted():
            yield b"partial "
            raise ConnectionError("lost stream")

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "result"
            destination.write_bytes(b"verified")
            with self.assertRaises(ConnectionError):
                write_download(destination, interrupted())
            with self.assertRaisesRegex(ValueError, "Incomplete"):
                write_download(destination, [b"short"], expected_size=12)
            with self.assertRaisesRegex(ValueError, "expected SHA-256"):
                write_download(destination, [b"different"], expected_hash="0" * 64)
            self.assertEqual(destination.read_bytes(), b"verified")
            self.assertEqual(list(destination.parent.iterdir()), [destination])


if __name__ == "__main__":
    unittest.main()
