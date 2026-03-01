# Security Policy

## Reporting a Vulnerability

If you believe you found a security vulnerability:

- Do not open a public issue.
- Do not include OAuth client secrets, tokens, or message contents in reports.

Send a private report to the repository maintainers.

## Threat Model Notes

This project connects to Gmail via OAuth and can move messages to Trash and send unsubscribe emails.

Treat it as high-trust code:

- Keep `secrets/` out of git.
- Keep local config files out of git (e.g. `config/config.yaml`).
- Revoke OAuth access if you suspect compromise.
