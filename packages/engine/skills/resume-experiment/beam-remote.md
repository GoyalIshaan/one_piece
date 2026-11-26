# Beam commands and recovery


For an existing Beam image, submit the command below on the Beam pool using the helper and SDK Python paths in its description. Add `--gpu`, `--volume NAME:/mount`, or `--secret NAME` when your workload needs them. The job holds the lease while the helper launches, streams the remote command's logs and confirms cleanup.

```sh
BEAM_SDK_PYTHON TRACKED_POD_PATH run --image IMAGE_ID --receipt pod-launch.json --timeout-seconds 600 -- COMMAND ARGUMENTS
```

Use a larger scheduler timeout than the helper's timeout so the helper can confirm cleanup.

If a workload can emit a flushed line when its own work starts, add `--start-marker PREFIX --run-timeout-seconds SECONDS`. Then `--timeout-seconds` is the time allowed for launch plus waiting for that line. The first output line starting with the literal prefix grants the separate runtime budget. Give the scheduler enough time for both budgets and cleanup.

Include `pod-launch.json` in the job's output files. The helper writes the unique stub ID before making the creation request and refuses a second request using the same receipt. For a custom SDK configuration, the same helper exports `create_tracked(pod, Path("pod-launch.json"))` for a fresh SDK `Pod`.

If the response is lost, inspect the receipt with `python3 /path/to/tracked_pod.py pod-launch.json --beam /path/to/beam`. It reads provider tasks and containers for that exact stub. `not_observed` means the provider has no visible match at the moment. Continue reconciliation before retrying. With one unambiguous match, use the reported task and container IDs to examine its status and logs. When stopping a Pod this attempt owns, stop only its exact container ID and verify the provider no longer shows an active task or container for that stub.

For a file saved on a Beam volume, the advertised `volume_file.py` downloads it directly inside a worker sandbox when multipart `beam cp` cannot use its local manager socket:

```sh
BEAM_SDK_PYTHON VOLUME_FILE_PATH beam://VOLUME/path/to/result.json ./result.json --sha256 PRODUCER_DIGEST
```

The digest argument is optional. When you have the producing job's digest, give it here to validate the bytes before replacing a local file.
