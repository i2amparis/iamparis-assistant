# Automatic deploys to the EOSC VM

Every push to `main` runs the unit tests and then deploys to the EOSC VM ([.github/workflows/deploy-eosc.yml](../.github/workflows/deploy-eosc.yml)). A deploy can also be started from the Actions tab (**Deploy to EOSC VM → Run workflow**). Each run shows the result in the Actions tab.

## How it works

1. The Action connects over SSH as the user `deploy` with a key kept in the repository's secrets. The VM's host key is pinned in the workflow.
2. On the VM that key has a forced command: it can only run `/usr/local/sbin/iamparis-deploy <commit>` ([deploy/iamparis-deploy](../deploy/iamparis-deploy)). It cannot open a shell, forward ports or run anything else.
3. The script checks that the commit is on `main`, then deploys the tip of `main`: fetch, `pnpm install`, `pnpm build`, restart `iamparis-assistant`.
4. It waits for `/api/status` to report the classifier as available. If it does not, the previous commit is restored and the run fails.

Deploys run one at a time. The curation check is not part of a deploy; run it on the VM by hand after changes to classifier prompts (see [persona-study/README.md](persona-study/README.md#eosc-vm-check)).

## Setup (done once)

On the VM (done on 2026-11-26):

```bash
sudo bash deploy/eosc-github-deploy-setup.sh "$(cat iamparis_github_deploy.pub)"
```

In GitHub, under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret            | Value                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `EOSC_HOST`       | The VM's public IP address (kept out of this public repository)                                    |
| `EOSC_DEPLOY_KEY` | The whole private key file `~/.ssh/iamparis_github_deploy` (from `-----BEGIN` to `END … KEY-----`) |

The key pair was made on the maintainer's PC; after adding the secret, the local private key can be deleted. To replace the key, make a new pair, run the setup script again with the new public key, and update the secret.

## When something changes

- **The VM's IP changes:** update `EOSC_HOST`.
- **The VM is rebuilt:** its host key changes, so update the pinned key in the workflow (`ssh-keyscan -t ed25519 <ip>`, and check its fingerprint on the VM console), then run the setup script again.
- **Deploy another branch:** change `BRANCH` in `deploy/iamparis-deploy` (reinstall it with the setup script) and `branches` in the workflow.
- **Roll back:** revert the commit on `main` and push; the revert deploys like any other change.
