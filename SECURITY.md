# Security policy

EvlEDA is an engineering preview that launches local code and may invoke
KiCad. Treat the MCP server and plugins as trusted executable software.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for the published repository if it
is enabled. Otherwise contact the repository maintainers through a private
channel listed on the repository owner profile. Do not include exploit details,
private board data, credentials, signing material, or proprietary source files
in a public issue.

Include the EvlEDA version/commit, operating system, Python and KiCad versions,
affected command/tool, reproduction steps, impact, and whether untrusted input
or user interaction is required. Maintainers will acknowledge a report when a
public security contact is established; no response-time SLA is claimed yet.

## Supported versions

Only the current 0.2.x development line receives security fixes. There is no
production support or long-term-support release.

## Security model

- The MCP process communicates only over stdin/stdout with the local Codex or
  Claude Code parent process. It opens no listening socket and provides no
  HTTP, hosted, remote, account, or multi-tenant runtime.
- The reference host exposes a fixed project and no arbitrary shell or file
  path tools.
- KiCad discovery accepts an exact KiCad 10 executable, records its hash, and
  worker execution uses fixed argv without a shell.
- Tool listing and dispatch use the same capability allowlist. Caller metadata
  cannot select actor privilege, project scope, worker identity, or rule policy.
- State, HMAC/signing keys, approval records, and evidence may be sensitive.
  Protect the state root with operating-system access controls and do not commit
  secrets.
- Plugins execute with the local user's privileges. Review the plugin manifest,
  MCP configuration, skills, and repository provenance before installation.
- Resource limits are a security boundary. Do not enable the unsafe unbounded
  override on shared, automated, or cost-bearing infrastructure.

## Hardware safety is separate

Software integrity does not establish electrical safety. ERC/DRC, deterministic
checks, and reproducible CAM cannot replace qualified electrical, thermal, EMC,
regulatory, fabrication, assembly, and first-article review. EvlEDA outputs
remain non-release unless an authorized human closes those gates for the exact
artifact.

## Out of scope for this preview

Public or loopback HTTP hosting, listening sockets, remote transport,
multi-tenant isolation, accounts, authentication as a service, production key
management, and supply-chain attestations for published binary packages are not
part of the product. Do not wrap EvlEDA in a network service without designing
and reviewing a new security boundary.
