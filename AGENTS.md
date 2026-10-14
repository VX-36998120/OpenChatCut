# Repository maintenance

## Windows build before a new version

Before pushing or publishing a new OpenChatCut version, run the `desktop` GitHub Actions workflow against the candidate branch or commit. Confirm the Windows x64 packaging job and its installer smoke test pass, and retain the generated Windows installer artifact for testing. Do not treat a macOS build as Windows validation, and do not publish a release when the Windows build or smoke test fails.
