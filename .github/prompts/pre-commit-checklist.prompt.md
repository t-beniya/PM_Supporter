---
description: Pre-commit safety checklist
---

# Pre-Commit Checklist

Before committing, verify at least the following items.

- Run unit tests.
- Run the build.
- Run SAST.
- Run pre-commit.
- Check that no secrets are written in the repository.
- Check that no API keys are written in the repository.
- Check that no local machine paths are written in the repository.

If any check fails or is not run, document the reason and remaining risk before committing.
