from pathlib import Path
from playwright.sync_api import sync_playwright


output = Path(__file__).parent / "artifacts"
output.mkdir(exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe",
    )
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))

    page.goto("http://127.0.0.1:4173", wait_until="networkidle")
    assert page.title().startswith("AetherAC")
    assert "AetherAC" in page.content()
    assert page.locator("h1").is_visible()
    assert page.locator(".home-feature-grid article").count() == 4
    assert page.locator("a[href='/blog']").first.is_visible()
    page.screenshot(path=str(output / "desktop.png"), full_page=True)

    page.goto("http://127.0.0.1:4173/blog", wait_until="networkidle")
    assert page.locator(".post-card").count() >= 2

    page.goto("http://127.0.0.1:4173/news", wait_until="networkidle")
    assert page.locator(".post-card").count() >= 2

    page.goto("http://127.0.0.1:4173/progress", wait_until="networkidle")
    assert page.locator(".stage-list article").count() >= 5
    assert page.locator(".github-panel").is_visible()
    page.screenshot(path=str(output / "progress.png"), full_page=True)

    page.goto("http://127.0.0.1:4173/studio", wait_until="networkidle")
    assert page.locator(".studio-state").is_visible()

    page.set_viewport_size({"width": 390, "height": 844})
    page.goto("http://127.0.0.1:4173", wait_until="networkidle")
    page.locator(".nav-toggle").click()
    assert page.locator(".mobile-links").is_visible()
    page.screenshot(path=str(output / "mobile.png"), full_page=True)

    if errors:
        raise AssertionError("Browser errors: " + " | ".join(errors))
    browser.close()
