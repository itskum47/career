# Candidate Profile Setup

1. Copy the template:
   ```bash
   cp profile/master_profile.example.yaml profile/master_profile.yaml
   ```
2. Fill in `profile/master_profile.yaml` with your real details (or run `npm run profile:import` if available).
3. Approve the profile version:
   ```bash
   npm run agent -- profile:approve   # or follow the escalation flow
   ```
4. The agent will refuse to submit applications until `profile/master_profile.yaml` exists and is approved.

`profile/master_profile.yaml` is gitignored — never commit your real profile.