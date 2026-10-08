# Wall display

Read docs/spec.md before any work. It is the source of truth. Sections 1-13 are v1.
Section 14 (home screen) is parked: do not build it.

Rules
- Work on one milestone at a time (spec section 12), and only the one I name.
- Stop and flag instead of silently changing any contract in spec sections 4, 7 or 10.
- Put judgment calls in the milestone report for me to ratify.
- No secrets in the repo or in logs. Real values go in .env, which is git-ignored.
- Keep it simple: no screens, features or dependencies the spec does not call for.
- Screens follow the section 4 contract. The lint rule that bans raw timers, listeners,
  EventSource and fetch inside screens must stay on.
- All colour, type and spacing come from client/src/theme.css (spec section 9).

At the end of each milestone, write docs/reports/milestone-N.md: what shipped, deviations
from the spec, measured numbers against the section 11 budget, spike results.
