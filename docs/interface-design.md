# Stratus interface

The workspace pairs a deployment history with the selected release, production
actions, and build logs. The activity counts cover the latest 20 deployments
returned by the API.

## Visual design

Rethink Sans is used for the interface. Geist Mono is used for identifiers and
build commands. The workspace uses slate neutrals and a deep blue for primary
actions. Status labels name the outcome as well as showing its color.

A photograph of Earth's horizon ties the deploy form and sign-in pages to the
Stratus name. The workspace reserves most of its space for release history,
actions, and logs. The sign-in and registration screens use a larger crop of the
same photograph on desktop and a compact crop on mobile.

[Photograph credit: NASA Johnson Space Center, ISS Expedition 23](https://science.nasa.gov/earth/earth-observatory/sunset-from-the-international-space-station-44267/)

## Behavior

- The repository check appears below the source field. When the root lacks a
  package manifest, **Choose project folder** opens and focuses the folder field.
- On phones, selecting a release reveals its details. **Back to deployments**
  returns focus to the selected row.
- Preview and production links are separate. Release actions and removal
  controls are visually distinct. Destructive actions use a confirmation dialog
  with Cancel focused first and Escape support.
- The build log header indicates whether output is saved, live, unavailable, or
  pending. Log connection status is kept outside the build output.

## Verify the interface

Run `npm run lint`, `npm run build`, and `npm run test:e2e` from `apps/web`.
Browser tests use an isolated database and write screenshots to `test-results/`.
They cover auth, repository checks, responsive layouts, keyboard interaction,
confirmation dialogs, and automated accessibility checks.

For a real release check, start the local stack with `npm run dev`, then run
`npm run test:workspace` from the root. It builds two Node.js releases,
promotes the second, rolls back, and removes the superseded preview. It leaves
the test project's initial production runtime available for inspection. See
[local deployment](local-deployment.md) for setup.
