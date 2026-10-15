# Operate within the Railway spending limit

The approved workspace settings are a **$20 Compute hard limit** and a **$15 custom email alert**.
The operator read back both settings during setup. This verifies the saved controls, not Damadama's operating cost or email delivery.
The former $20 to $35 monthly allowance was a historical planning estimate for two awake environments, not an approved overage.

The intended workload has an app, a private PostgreSQL 17 service, and a daily backup job in each environment.
The latest setup readback has 0.5 CPU and 500 MB ceilings on all six services, PostgreSQL online, and app and backup services offline.
Those ceilings constrain available resources. They do not measure average consumption or prove that two awake environments fit within $20.
Hosted app use, private image pulls, backup completion, and hosted restore remain unverified.

## Understand the billing boundary

Railway's [Compute limit](https://docs.railway.com/pricing/cost-control) covers service CPU, memory, storage, and network egress across the workspace.
At the hard limit, Railway takes workspace workloads offline, including both environments and their backup jobs.
Railway Agent has an independent limit. Do not use it as part of this operating plan.

The [Pro plan](https://docs.railway.com/pricing/plans) has a $20 monthly subscription with $20 of included resource usage.
Included usage offsets resource charges and resets each billing cycle. It is not an extra $20 to add to usage below that allowance.
The Compute hard limit is a shutdown threshold, not a $20 all-in invoice guarantee.
Retained volumes still have [billable used storage](https://docs.railway.com/volumes/reference).
[Bucket access is suspended at the hard limit](https://docs.railway.com/storage-buckets/billing), but existing stored bucket data remains billed.
Do not delete volumes or backups to reduce an invoice.

GitHub Actions artifacts and caches, Clerk usage or paid features, and domain registration and renewal are outside the Railway Compute limit.
Check their current account allowances and billing separately. This runbook does not guarantee that any of them remains free.
Taxes, separate Railway Agent usage, and optional paid services can also affect the total.

## Respond to the $15 alert

The workspace billing operator reads the custom $15 email and Railway's hard-limit notices at 75%, 90%, and 100%.
For a $20 limit, those notices correspond to $15, $18, and $20. The $15 alert leaves services running.
Confirm the recipient in workspace settings. A configured alert is not evidence that an email arrived.

1. Open the correct workspace's Usage page. Record the billing-cycle end, current Compute usage, forecast, and saved $20 and $15 settings separately.
2. Inspect usage by project and service, including other workspace projects, retained storage, backup uploads, and overlapping deployments.
3. Check CPU, memory, egress, service status, and the latest completed backup in each environment. Record failed or still-running backup jobs.
4. Defer optional deployments and restore rehearsals that would consume the remaining allowance. Preserve the data volumes and seven-day backup retention.
5. Tell the operator whether the forecast reaches $20 before reset and whether a backup gap or outage is likely. Record the decision and its evidence.

Do not raise or remove the hard limit, add a paid service, or incur new recovery spend without explicit operator approval.
If the operator keeps the no-overage policy, preserve the limit and accept a possible outage until the next billing-cycle reset.
Follow [recovery after a spending hard stop](recovery.md#recover-after-a-spending-hard-stop) if workloads stop.

## Verify the operating cost

Record representative hosted usage after the first day, week, and full billing cycle.
Include successful authenticated app work, daily backup execution, storage, service egress, and deployment overlap in the forecast.
An idle database, local container test, or another project's current-cycle charge cannot establish Damadama's full operating cost.
Keep availability and budget claims unverified until the hosted workload and billing evidence support them.
