# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Build, please report it responsibly.

**Do not open a public issue.**

Instead, email **security@parcha.ai** with:

- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix (optional)

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation plan within 7 days.

## Scope

This policy covers the Build application source code and its build/distribution pipeline.

Third-party dependencies are managed via npm and are outside the direct scope of this policy, but we welcome reports about vulnerable dependencies.

## API Keys

Build stores API keys locally via `electron-store`. Keys are never transmitted to any server other than the respective API provider (Anthropic or OpenAI). The Realtime WebRTC transport receives only a short-lived client secret, not the stored OpenAI API key. No telemetry or analytics are collected.
