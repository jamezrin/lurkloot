---
title: Report a problem
description: What to include in a bug report so the problem can be found and fixed quickly.
sidebar:
  order: 99
---

If Lurkloot is doing something wrong, [open a bug report on GitHub](https://github.com/jamezrin/lurkloot/issues/new?template=bug_report.yml). The form asks what happened, how to make it happen again, and a few details about your setup. Before you file, search the [existing issues](https://github.com/jamezrin/lurkloot/issues). Someone may already have reported it.

## Find your version

Your Lurkloot version is shown at the bottom of the popup. You can also find it on your browser's extensions page. For the CLI, it is the version of the release or Docker image you run, and the diagnostics report below includes it.

## Include the log

The log shows what Lurkloot was doing when the problem happened. It is usually the most useful part of a report.

1. Open the popup and go to **Activity**.
2. Click **Copy log**.
3. Paste it into the report.

For a problem that is hard to pin down, also attach the diagnostics:

1. In Settings, check that **Include diagnostic logs** is on. It is on by default.
2. In **Activity**, switch to the **Diagnostics** tab and click **Export all**.
3. Attach the file to the report.

If Lurkloot shows *Lurkloot has stopped working*, its **Copy logs & open issue** button copies the log and opens the report form for you.

## From the CLI

Export a diagnostics report after the problem happens, using the same config as the running CLI:

```bash
lurkloot diagnostics export --config config.json --out diagnostics.log
```

With Docker Compose:

```bash
docker compose exec -T lurkloot node /app/dist/index.mjs diagnostics export --config /data/config.json > diagnostics.log
```

If you start the CLI with its own `--state` file, add the same `--state` path to the command (with Docker, before the `>`).

Attach `diagnostics.log` to the report. It has no tokens or cookies in it.

## Keep your account safe

Never paste a password, cookies or a session token into a report, and never attach the file from **Export credentials**. Logs and diagnostics leave those out. If you are asked to share anything else, check what is in it first.

## Ideas and requests

If you want Lurkloot to do something new rather than fix something, open a [feature request](https://github.com/jamezrin/lurkloot/issues/new?template=feature_request.yml) instead.
