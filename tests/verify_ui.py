from pathlib import Path
from playwright.sync_api import sync_playwright

base = "http://127.0.0.1:5173"
routes = ["/", "/login", "/register", "/admin", "/buy", "/me", "/order?order_id=example"]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("console", lambda msg: errors.append(f"console:{msg.type}:{msg.text}:{msg.location}") if msg.type == "error" and not msg.location.get("url", "").endswith("/favicon.ico") else None)
    page.on("pageerror", lambda error: errors.append(f"page:{error}"))
    page.on("response", lambda response: errors.append(f"http:{response.status}:{response.url}") if response.status >= 400 else None)
    for route in routes:
        response = page.goto(base + route, wait_until="networkidle")
        text = page.locator("body").inner_text().strip()
        print(f"{route} status={response.status if response else 'n/a'} content={len(text)}")
        assert text, f"blank page: {route}"
        assert page.locator(".vite-error-overlay").count() == 0, f"Vite overlay: {route}"
        if route == "/":
            sweep = page.locator(".radar-rings span")
            before = sweep.evaluate("node => getComputedStyle(node).transform")
            page.wait_for_timeout(250)
            after = sweep.evaluate("node => getComputedStyle(node).transform")
            assert before != after, "radar sweep is not rotating"
        if route == "/login":
            page.screenshot(path=str(Path("tests/artifacts/login-fluent.png")), full_page=True)
    if errors:
        print("\n".join(errors))
        raise SystemExit(1)
    browser.close()
