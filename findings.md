# Web admin findings

- DSH 0.1.1-rc.2 public SessionPersistence.inspect/readFrom are read-only; load commits recovery and is forbidden for browsing.
- Public SystemPrompt.section supports scoped dynamic providers; snapshots must be frozen per turn, since assembly runs per model step.
- Public schedule tools schedule_create/list/delete own durable changes. Do not write schedule events manually.
- Host foreground is derived from configured QQ peer; hidden roles decision/dream/maintenance share ID prefix.
- Existing Host wakeForeground drops the WakeResult, preventing Bridge proactive send. Fix and regression-test it.
- MemoryService supplies controlled apply/list/read/search/projections and safe filesystem boundaries; revisions contain metadata, not full historical snapshots.
- Existing architecture page on 3181 is static and must remain separate from live admin.
- Existing dirty changes are README/package scripts, Host and Runtime CLI fixes, architecture explorer, and operational workspace state. Never read credential contents or overwrite operational data.
