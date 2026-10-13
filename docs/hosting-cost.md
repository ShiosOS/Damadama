# Cost of two awake environments

Estimate checked on 2026-10-12. This is a forecast, not measured Damadama usage or a spending cap.
Approve the hosting plan and domains separately before provisioning.

The proposed host is Railway. Each environment runs one awake ASP.NET app and one private PostgreSQL 17 service with a separate volume.
Each also has its own short daily backup job and backup bucket. Clerk uses two separate applications with isolated production instances.

| Monthly assumption for both environments                                       | Estimated charge |
| ------------------------------------------------------------------------------ | ---------------- |
| Total average RAM of 1 to 2 GB across four awake services, at $10 per GB-month | $10 to $20       |
| Average CPU of 0.1 to 0.3 vCPU total, at $20 per vCPU-month                    | $2 to $6         |
| Two 2 GB database volumes, at $0.15 per GB-month                               | $0.60            |
| Up to 2 GB of encrypted logical backups, at $0.015 per GB-month                | $0.03            |
| 10 GB of service egress, including backup uploads, at $0.05 per GB             | $0.50            |
| Brief daily backup jobs, estimated allowance                                   | $0.50            |
| Estimated resource usage                                                       | $13.63 to $27.63 |

Railway Pro has a $20 monthly minimum with $20 of included usage. Private container registry credentials require Pro.
The estimated combined bill is therefore about **$20 to $28 per month**, with **$20 to $35** as a planning allowance for early variance.
Do not add the $20 subscription again to the usage estimate; included usage offsets it.
Database size, real memory, CPU, egress, retained backups, taxes, and any domain registration can raise the total.

Railway Hobby has a $5 minimum with included usage, but requires a public image for this deployment approach.
With public GHCR images, the same forecast is about **$14 to $28 per month**. That option publishes every staged application artifact.
The repository is public, but choose image visibility explicitly. The default proposed setup uses private images and Pro.

Clerk's Hobby plan currently includes unlimited applications, 50,000 monthly retained users per application, and a fixed seven-day session lifetime.
At small staging/production usage, the proposed separate Clerk applications cost $0. Paid features or threshold growth require reassessment.
Production Clerk instances need approved domain configuration; provider-generated app domains alone do not complete that setup.

GitHub currently charges $0 for Container Registry image storage and bandwidth. Recheck that policy before provisioning or changing retention.
Standard GitHub-hosted runners for this public repository are free. Artifact storage follows the account's Actions storage allowance and billing policy.
Only the large transfer archive lasts three days; release metadata lasts 90 days. At a 0.3 GB archive and one candidate per day, steady transfer storage is about 0.9 GB.
At GitHub's $0.25 per GB-month artifact rate before included allowances, that is about $0.23 per month. At three candidates per day, it is about $0.68.
The $20 to $35 planning allowance includes this small artifact charge. Confirm actual artifact size, run count, storage allowance, and cache usage during setup.

Railway native daily snapshots retain six days. They do not satisfy the agreed seven-day daily-backup retention alone.
Use the encrypted logical-backup job as the required seven-day source. Optional native snapshots add billed retained volume storage.
No optional snapshots are included in the estimate. Bucket egress is free, but the service uploading a backup incurs service egress.

The former $10 to $15 target is optimistic once two environments remain awake. Review actual usage after the first day, week, and billing month.
Set budget alerts during approved setup. Keep the app and database awake; do not use a hard spending shutdown as an unreviewed substitute for availability.
Start with 512 MB app/database memory limits if runtime measurements permit them. Adjust after observing pressure and PostgreSQL cache needs.

## Primary pricing sources

- [Railway pricing](https://railway.com/pricing)
- [Railway usage rates and included credits](https://docs.railway.com/pricing/plans)
- [Railway private registry plan requirement](https://docs.railway.com/builds/private-registries)
- [Railway backup retention](https://docs.railway.com/volumes/backups)
- [Railway bucket billing](https://docs.railway.com/storage-buckets/billing)
- [Clerk pricing](https://clerk.com/pricing)
- [GitHub Container Registry billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)
- [GitHub Actions artifact billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
