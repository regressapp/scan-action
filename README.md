# Regress Scan

Starts a [Regress](https://regress.app) scan of your web app from a GitHub Actions workflow. Use it after a deploy so the new build gets checked. It can also wait for the scan and fail the job if something broke.

It calls the Regress [deploy webhook](https://regress.app/docs/deploys) for you: it signs the request with your webhook secret and sends it to `https://api.regress.app`.

## Setup

1. In Regress, open Project settings, find Deploy webhook, and click Generate secret. The webhook URL next to it contains your project ID.
2. In your GitHub repository, add two secrets: `REGRESS_PROJECT_ID` and `REGRESS_WEBHOOK_SECRET`.

## Usage

Run a scan after your deploy job:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh

  regress:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: regressapp/scan-action@v1
        with:
          project-id: ${{ secrets.REGRESS_PROJECT_ID }}
          webhook-secret: ${{ secrets.REGRESS_WEBHOOK_SECRET }}
```

Run a scan when a deployment succeeds (for hosts that report GitHub deployments, such as Vercel):

```yaml
on:
  deployment_status:

jobs:
  regress:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: regressapp/scan-action@v1
        with:
          project-id: ${{ secrets.REGRESS_PROJECT_ID }}
          webhook-secret: ${{ secrets.REGRESS_WEBHOOK_SECRET }}
```

Wait for the result and fail the job on a regression:

```yaml
      - uses: regressapp/scan-action@v1
        with:
          project-id: ${{ secrets.REGRESS_PROJECT_ID }}
          webhook-secret: ${{ secrets.REGRESS_WEBHOOK_SECRET }}
          wait-for-result: true
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `project-id` | yes | | Your Regress project ID. |
| `webhook-secret` | yes | | The deploy webhook secret from Project settings. |
| `wait-for-result` | no | `false` | Wait for the scan to finish, then fail the job on a regression. |
| `timeout-minutes` | no | `20` | How long to wait when `wait-for-result` is `true`. The job fails if the scan is still running after this. |
| `api-url` | no | `https://api.regress.app` | Regress API base URL. |

## Outputs

| Output | Description |
| --- | --- |
| `check-run-id` | ID of the scan that was started. |
| `status` | Scan status. Without `wait-for-result` this is the status when the request was made. |
| `pages-checked` | Pages checked. Only set when `wait-for-result` is `true`. |
| `change-count` | Changes found. Only set when `wait-for-result` is `true`. |
| `flows-tested` | Flows tested. Only set when `wait-for-result` is `true`. |
| `flows-failed` | Flows that failed. Only set when `wait-for-result` is `true`. |

## Behaviour

- Without `wait-for-result`, the step finishes as soon as Regress accepts the request. Results appear on your Regress dashboard.
- With `wait-for-result`, the action checks the scan status every 15 seconds. It fails the job if the scan status is `failed`, if any flow failed, or if any change was found.
- If a scan is already running for the project, Regress does not start another. The action reports the running scan, and waits for it when `wait-for-result` is `true`.
- If Regress rejects the request (wrong project ID, wrong secret, no webhook secret set, or an error on the Regress side), the step fails and prints the HTTP status and message.
- Regress limits the webhook endpoints to 10 requests a minute per IP address. On a `429` response the action waits for the `Retry-After` time and tries again, up to 5 times.

## Requirements

The action runs on the Node 24 runtime and has no dependencies.

## License

[MIT](LICENSE)
