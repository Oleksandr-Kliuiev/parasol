# Load test

`workday.js` is the k6 scenario behind NFR-01 and NFR-01b: the reads a CRM user makes during a working day — "my day",
a customer card, the global search, the pipeline and the dashboard — driven by as many virtual users as the company has
people.

```bash
brew install k6                                  # or: docker run --rm -i grafana/k6 run - < workday.js
k6 run -e BASE_URL=http://localhost:5180 tools/load-test/workday.js
k6 run -e BASE_URL=https://crm-test.example.no -e VUS=50 -e DURATION=10m tools/load-test/workday.js
```

- The scenario signs in through the **development sign-in** (`/bff/dev-login`), so it only works where `Auth:Mode=Development`
  is set: locally and in the `test` environment. Never point it at production.
- Thresholds fail the run when p95 of a read goes above 500 ms, the search above 1 s, or more than 1 % of requests fail.
- Volumes matter more than the number of users (NFR-04). Seed a realistic database first: 5 000 organizations, 50 000
  contacts, a year of tickets and time entries. Without data the numbers flatter the system.
- Results belong in the release checklist (docs/07-nfr-devops.md §7): p95 per endpoint, the slowest endpoints and what was
  done about them.
