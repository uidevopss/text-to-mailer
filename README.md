# Text-to-Mailer — Bridge V18

## What it does

Convert raw email content into a designed, email-compatible HTML mailer using an assisted workflow for banner creation, email-code generation, asset integration, preview and refinement.

## New in V18

### Optional multiple emailers
- The normal **Generate Mailer** action remains the default; creating multiple designs is optional.
- Enable **Generate multiple unique emailers** in Step 3, or open **Generate variations (optional)** in Step 4.
- Choose **2, 3, or 4** designs. The maximum is capped at **4** in both the controls and generation logic.
- Each variation gets a different layout, typography, shape language and banner direction. The comparison panel displays the results so a design can be selected, refined, copied or downloaded.

### Website brand-colour extraction
- Enter a brand website in **Brand website for colours** (for example, `https://adamasuniversity.ac.in/`), or include the URL in the email content or instructions.
- When generating an emailer, the local bridge reads the public website HTML and linked stylesheets, samples its CSS colours and passes the extracted palette to the banner and email-design prompts.
- The emailer and banner are directed to use the site's colours consistently, with neutral backgrounds and accessible text contrast.
- If the website is unavailable or contains no usable CSS colours, generation continues with the normal automatic palette.
- The website fetcher only permits public HTTP/HTTPS sites and blocks localhost/private IP addresses.

## Existing workflow

- Four-step flow: **Paste Content → Choose Hero → Review & Generate → Final Mailer**.
- AI-1 image generation through the persistent Microsoft Edge session; banner assets are optimized to max 650px wide and below 1 MB.
- AI-2 email-code generation using the API key configured in Settings.
- Supports explicit hero copy with `{banner}...{/banner}`.
- Optional top-left and top-right logos, design instructions, text-based hero mode, preview (desktop/mobile/HTML), editing, refinement, saved gallery, copy and HTML download.
- The generated banner and logos are integrated into the HTML email after code generation.

## Run locally

1. Install Node.js 18 or newer.
2. Extract the ZIP to a writable folder.
3. Run `start-chatgpt-bridge.bat`.
4. Open `http://127.0.0.1:3210/`.
5. The bridge uses a dedicated `.edge-chatgpt-profile` folder. Log in once in that Edge profile; later runs reuse it until the session expires or the profile is removed.

## Notes

- Keep the browser bridge running while generating banners.
- For brand colours, the site URL must be publicly reachable from the machine running the bridge.
- The generated HTML should still be previewed and tested in the target email platform before sending a campaign.
