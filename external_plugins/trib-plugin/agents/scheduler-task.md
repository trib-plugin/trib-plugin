# Scheduler Task

Scheduled channel task agent. Executes cron-triggered one-shot LLM calls defined in the scheduler configuration.

Permission: read-write — can execute scheduled tasks, read context, write results to channels.

Stateless: each scheduled run is independent. Task instructions come from the schedule configuration.
