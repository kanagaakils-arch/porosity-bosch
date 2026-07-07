import asyncio
from playwright.async_api import async_playwright
import base64

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # Listen for console logs
        page.on("console", lambda msg: print(f"CONSOLE {msg.type}: {msg.text}"))
        page.on("pageerror", lambda exc: print(f"PAGE ERROR: {exc}"))
        
        await page.goto("http://127.0.0.1:8002/")
        print("Page loaded")
        
        # Wait for the app to initialize
        await page.wait_for_timeout(1000)
        
        # Create a dummy image
        img_bytes = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
        with open("dummy.png", "wb") as f:
            f.write(img_bytes)
            
        # Upload the image
        print("Uploading image...")
        await page.set_input_files("input[type='file']", "dummy.png")
        
        # Wait for upload to process
        await page.wait_for_timeout(2000)
        
        print("Test complete")
        await browser.close()

asyncio.run(main())
