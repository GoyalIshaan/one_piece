# Inkling checkpoint staging and recovery

Run this controller through the harness's serialized Beam pool for an authorized staging attempt. Use a new local directory for the receipt of each attempt.

```sh
python3 tools/inkling-beam-stage/run.py --single-authorized-run --output-dir /path/to/attempt-1
python3 tools/inkling-beam-stage/run.py --single-authorized-run \
  --resume-from /path/to/attempt-1/receipt.json --output-dir /path/to/attempt-2
```

Resume checks the exact retained Beam volume name and ID and confirms the previous sandbox has settled. With a complete marker, the controller verifies the marker and the volume's file paths and sizes without starting another sandbox. If staging was incomplete, a new sandbox mounts the same volume. It rehashes published files, continues valid `.part` files using HTTP Range, and verifies each publisher pin before publishing a complete marker.

Use the latest attempt's receipt for another retry. A failed validation retains the volume and local evidence. Only a receipt with `ready: true` and a `consumption` entry authorizes a consumer to use the staged files. A corrupt partial or mismatched published file requires operator review. The stager leaves both on the volume.

Run the offline regression tests from the repository root with `python3 -B -m unittest discover -s tools/inkling-beam-stage`.
