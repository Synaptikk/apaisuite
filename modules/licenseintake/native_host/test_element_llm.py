"""
Quick connectivity test for Element LLM (https://element.walmart.com).

Run from Git Bash:
    python native_host/test_element_llm.py

Pass --image path/to/license.jpg to also test the vision endpoint.
"""
import sys
import json
import base64
import argparse

def test_text(session):
    """Test with a text-only prompt (no image, fast, small)."""
    print("→ Testing text endpoint...")
    resp = session.post(
        "https://element.walmart.com/v1/chat/completions",
        headers={"Content-Type": "application/json"},
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "max_tokens": 10,
            "temperature": 0,
        },
        timeout=15,
    )
    print(f"  Status: {resp.status_code}")
    if resp.status_code == 200:
        try:
            msg = resp.json()["choices"][0]["message"]["content"]
            print(f"  Response: {msg!r}")
            print("  ✅ Text endpoint REACHABLE")
            return True
        except Exception as e:
            print(f"  ⚠ Unexpected response shape: {e}\n  Body: {resp.text[:300]}")
    else:
        print(f"  ❌ HTTP {resp.status_code}")
        print(f"  Body: {resp.text[:400]}")
    return False


def test_vision(session, image_path: str):
    """Test the vision endpoint with a real image file."""
    print(f"\n→ Testing vision endpoint with {image_path}...")
    with open(image_path, "rb") as f:
        raw = f.read()
    # Detect MIME type
    mime = "image/jpeg" if raw[:2] == b"\xff\xd8" else "image/png"
    img_b64 = base64.b64encode(raw).decode("ascii")

    resp = session.post(
        "https://element.walmart.com/v1/chat/completions",
        headers={"Content-Type": "application/json"},
        json={
            "model": "gpt-4o",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What do you see in this image? One sentence."},
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{img_b64}"}},
                    ],
                }
            ],
            "max_tokens": 60,
            "temperature": 0,
        },
        timeout=30,
    )
    print(f"  Status: {resp.status_code}")
    if resp.status_code == 200:
        try:
            msg = resp.json()["choices"][0]["message"]["content"]
            print(f"  Response: {msg!r}")
            print("  ✅ Vision endpoint REACHABLE")
            return True
        except Exception as e:
            print(f"  ⚠ Unexpected response shape: {e}\n  Body: {resp.text[:300]}")
    else:
        print(f"  ❌ HTTP {resp.status_code}")
        print(f"  Body: {resp.text[:400]}")
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", metavar="PATH", help="Optional: path to a license image for vision test")
    args = parser.parse_args()

    try:
        import httpx
    except ImportError:
        print("❌ httpx not installed.  Run: pip install httpx")
        sys.exit(1)

    # verify=False because the Walmart proxy does TLS MITM with internal CA
    with httpx.Client(verify=False, timeout=30) as session:
        text_ok = test_text(session)
        vision_ok = None
        if args.image:
            vision_ok = test_vision(session, args.image)

    print()
    if text_ok:
        print("Summary: Element LLM is REACHABLE from this Python environment.")
        if args.image:
            print("Vision:", "✅ works" if vision_ok else "❌ failed (text-only mode may still work)")
    else:
        print("Summary: Element LLM is NOT reachable.")
        print("  → Consider Tesseract fallback:  winget install UB-Mannheim.TesseractOCR")
        print("     Then:  pip install pytesseract pillow")
        sys.exit(1)


if __name__ == "__main__":
    main()
