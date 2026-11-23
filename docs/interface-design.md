# Stratus interface

The interface treats deployments as releases to inspect and manage. The main
view pairs a selectable release history with deployment details, production
actions and build logs. Summary counts describe the latest 20 deployments
returned by the API, not a global account total.

## Direction

- Cloud white `#f7f9fc`, paper `#ffffff`, ink `#17243d`, cobalt `#345cda`,
  slate `#586a85`, and dividers `#e3e8f0`.
- Geist for interface text and Geist Mono for deployment identifiers and logs.
- A persistent workspace sidebar and compact context header frame the content.
  On small screens, the history and inspector stack and sign-out remains available.
- Cobalt identifies primary actions. Green, amber and red communicate deployment
  outcomes with accompanying text. Charts and uptime claims are never fabricated.
- The authentication illustration depicts atmospheric layers, echoing the name
  Stratus and its layered brand mark. It is local SVG, with no external assets.

An initial direction of dark console chrome was rejected because it did not
connect the authentication and deployment experiences. The final light workspace
keeps a dark terminal as the one deliberate contrast for reading build output.

## References

- [Linear's UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui):
  navigation hierarchy, alignment and restrained chrome.
- [Vercel's dashboard redesign](https://vercel.com/blog/dashboard-redesign):
  prioritizing production and preview information.
- [Railway's dashboard layout](https://railway.com/changelog/2026-03-20-new-dashboard-layout):
  workspace navigation and information architecture.

These informed principles; their components, branding and artwork are not copied.

## Behavior and verification

Search and filters operate on the current release list. Environment-variable
values use masked inputs. Destructive operations use a native modal dialog with
cancel-first focus, keyboard containment, Escape dismissal and focus restoration.
Deployment API calls and session handling retain the existing backend contract.
Opening a log connection no longer implies that a completed build is BUILDING.
The terminal resizes to the inspector width with a cleaned-up ResizeObserver.

Run `npm run lint`, `npx tsc --noEmit`, `npm run build`, and `npm run test:e2e`
from `apps/web`. Browser tests use a separate temporary API database. They cover
authentication, keyboard interactions, search/filter behavior, masked variables,
confirmation dialogs, automated accessibility checks and horizontal overflow
at desktop, tablet and mobile sizes. Screenshots are saved in `test-results/`.
The browser-test API runs offline; a real Docker deployment is a separate check.

With the full stack running (`npm run dev`), run `npm run test:workspace` from
the repository root. This uses Chromium and the demo Alice account to submit two
real Node.js builds through the form, receive WebSocket logs, promote the second
runtime, roll back to the first, and delete the superseded preview. It checks
the deployment ID returned by the actual production HTTP endpoint after each
switch, rather than relying only on button responses. A uniquely named project
and its initial production runtime remain available for inspection. Reports and
screenshots are saved under the ignored `services/data/ui-flow/` directory.
The check does not modify production pointers of existing projects.
