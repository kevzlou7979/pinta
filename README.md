<p align="center">
  <img src="docs/assets/icons/icon-256.png" alt="Pinta" width="128" height="128" />
</p>

<h1 align="center">Pinta</h1>

<p align="center"><strong>Annotate your running web app. Let an AI agent do the edits.</strong></p>

<p align="center">
  <a href="https://pinta-companion.vercel.app/docs.html"><strong>Documentation</strong></a>
  &nbsp;·&nbsp;
  <a href="https://pinta-companion.vercel.app/">Website</a>
  &nbsp;·&nbsp;
  <a href="https://chromewebstore.google.com/detail/pinta/gnobpbogpbgdcpfjhbajfnbcfpbcnhah">Chrome Web Store</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/pinta-companion">npm</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="docs/assets/screens/app.gif" alt="Pinta annotation flow — circle a UI element, type a comment, and an agent edits the source." width="860" />
</p>

Circle a button, point at a heading, type *"make this tonal"*. Pinta
captures the annotation and a screenshot, and hands it to your coding agent
(Claude Code, Cursor, or any MCP tool), which edits the matching source
files. Built-in modules add GitLab issue filing, Test Pilot UAT runs,
AuditFlow audits, design variants, code review and more.

## Quick start

Needs **Node 20+** and **Chrome**.

1. Install the [Chrome extension](https://chromewebstore.google.com/detail/pinta/gnobpbogpbgdcpfjhbajfnbcfpbcnhah).
2. Run the companion in your project:

   ```bash
   npx pinta-companion .
   ```

3. Connect your agent — pick one:

   ```bash
   # Claude Code /pinta skill (then restart Claude Code and run /pinta)
   npx pinta-companion@0.10.0 install-skill

   # or MCP, for Claude Code / Cursor / Cline / Continue / Zed
   claude mcp add pinta -- npx -y -p pinta-companion pinta-mcp
   ```

Everything else — modules, settings, multi-project setup, troubleshooting —
is in the **[documentation](https://pinta-companion.vercel.app/docs.html)**.

## Anthropic compliance

Pinta is bring-your-own-Claude: it runs inside *your* interactive Claude Code
terminal and never proxies or stores Anthropic credentials. See the
[compliance page](https://pinta-companion.vercel.app/compliance.html).

## Development

```bash
npm install
npm test        # companion + extension suites
npm run build   # extension → extension/dist, companion → companion/dist
```

Design notes live in [`spec/SPEC.md`](spec/SPEC.md). Issues and PRs welcome.

## License

MIT — see [`LICENSE`](LICENSE). Made by Mark Kevin Baldemor
([@kevzlou7979](https://github.com/kevzlou7979)).
