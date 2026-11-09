# Tower Defense Demo: Developer Guidelines

1. **Deterministic Runtime (`src/runtime/`)**:
   - MUST NOT import Phaser or any DOM/Canvas APIs.
   - MUST NOT use `Math.random()`. Use a seeded deterministic random number generator instead.
   - MUST NOT use `Date.now()`. Rely strictly on simulation ticks.
   - All logic here must be purely data-driven, reproducible, and verifiable.

2. **Presentation Layer (`src/engine/` or Phaser integration)**:
   - Responsible strictly for rendering and user input.
   - Converts visual events into actions sent to the runtime.
   - No core logic resides here.

3. **Assets**:
   - Clean up `public/assets` and store only runtime-used assets there.
   - Put raw sources or extra Kenney files under the root `assets/` directory to avoid bloated builds.
