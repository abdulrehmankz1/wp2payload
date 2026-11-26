# ADR-0011: Re-encode raster images by default

- Status: Accepted.
- Context: Polyglot files can hide code inside an image, and EXIF data can hold GPS locations.
- Decision: JPEG, PNG, GIF, WebP and AVIF files are re-encoded with `sharp` at `media.reencodeQuality` (default 90), and their metadata is stripped. The SHA-256 used for deduplication and idempotency is taken from the original bytes before re-encoding, so it does not change with the `sharp` version or the quality setting.
- Consequences: A slight quality change and longer runs. `media.reencode: false` turns it off; each image stored that way is reported as `SEC_REENCODE_DISABLED`.
