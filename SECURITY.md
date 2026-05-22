# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Codex-Switch, please report it privately via GitHub's Security Advisory system:

1. Go to https://github.com/LeenixP/Codex-Switch/security/advisories/new
2. Describe the issue with as much detail as possible.
3. Allow time for the maintainer to respond before public disclosure.

Do not file a public issue for security vulnerabilities.

## Scope

Codex-Switch runs as a local proxy on 127.0.0.1. The attack surface is limited to:

- The HTTP proxy server bound to localhost.
- The Electron desktop shell.
- Provider configuration files stored on disk.

## Best Practices for Users

- API keys are encrypted at rest using the OS keychain where available (`safeStorage`). Keep your OS login credentials secure.
- The proxy listens on 127.0.0.1 by default — do not change this to a public interface unless you understand the risks.
- Review provider base URLs before saving to avoid sending credentials to untrusted endpoints.
