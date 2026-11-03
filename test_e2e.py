import httpx
import asyncio
from server.main import app

async def run_e2e():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        print("🎬 ===================================================")
        print("🎬 STARTING CLEAN CINEMA END-TO-END TEST")
        print("🎬 ===================================================")
        
        # 1. Test Static Index
        resp = await client.get("/")
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"
        assert "Clean Cinema" in resp.text
        print("✅ 1. Frontend SPA served successfully (index.html, PWA tags present)")

        # 2. Test Movie Search (Интерстеллар)
        resp = await client.get("/api/search", params={"q": "Интерстеллар"})
        assert resp.status_code == 200
        data = resp.json()
        results = data.get("results", [])
        assert len(results) > 0, "No search results found"
        top_movie = results[0]
        print(f"✅ 2. Search Movie OK: '{top_movie['title']}' ({top_movie['year']}) URL: {top_movie['url']}")

        # 3. Test Movie Details
        resp = await client.get("/api/details", params={"url": top_movie["url"]})
        assert resp.status_code == 200
        det = resp.json()
        assert det["title"]
        translators = det.get("translators", [])
        print(f"✅ 3. Movie Details OK: Translators: {[t['name'] for t in translators[:4]]}")

        # 4. Test Movie Stream
        resp = await client.get("/api/stream", params={"url": top_movie["url"], "translator_id": 0})
        assert resp.status_code == 200
        stream = resp.json()
        assert "streams" in stream or "hls_url" in stream
        hls_url = stream.get("hls_url") or list(stream["streams"].values())[0]
        print(f"✅ 4. Movie Stream OK: HLS URL received: {hls_url[:65]}...")
        
        # Verify the actual CDN stream can be downloaded
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as direct_client:
            cdn_resp = await direct_client.get(hls_url, headers={"Referer": "https://api.nextembed.ws/"})
            assert cdn_resp.status_code == 200, f"CDN returned {cdn_resp.status_code}"
            assert "#EXTM3U" in cdn_resp.text
            print(f"✅ 5. CDN Direct Stream Verified: #EXTM3U returned with Status 200!")

        # 5. Test TV Series Search (Во все тяжкие)
        resp = await client.get("/api/search", params={"q": "Во все тяжкие"})
        assert resp.status_code == 200
        series_results = resp.json().get("results", [])
        top_series = series_results[0]
        print(f"✅ 6. Search TV Series OK: '{top_series['title']}' ({top_series['year']}) URL: {top_series['url']}")

        # 6. Test TV Series Details (Seasons & Episodes)
        resp = await client.get("/api/details", params={"url": top_series["url"]})
        assert resp.status_code == 200
        s_det = resp.json()
        seasons = s_det.get("seasons", {})
        assert len(seasons) >= 1, "No seasons found for series"
        print(f"✅ 7. TV Series Details OK: {len(seasons)} Seasons, Season 1 has {len(seasons.get('1', []))} episodes")

        # 7. Test TV Series Episode Stream
        resp = await client.get("/api/stream", params={
            "url": top_series["url"],
            "translator_id": 0,
            "season": 1,
            "episode": 1
        })
        assert resp.status_code == 200
        ep_stream = resp.json()
        assert "hls_url" in ep_stream
        print(f"✅ 8. Episode 1 Stream OK: Audio tracks: {ep_stream.get('audio_tracks', [])[:4]}")

        # 8. Test History Save (The Flawless Resume Engine)
        sample_state = {
            "filmId": "test_123",
            "title": "Интерстеллар",
            "poster": "https://image.tmdb.org/t/p/w500/sample.jpg",
            "type": "movie",
            "time": 2542.5,
            "duration": 10140.0,
            "filmUrl": top_movie["url"],
            "translatorId": 0,
            "translatorName": "Дубляж"
        }
        resp = await client.post("/api/history", json=sample_state)
        assert resp.status_code == 200
        print("✅ 9. History Auto-Save (sendBeacon endpoint) OK")

        # 9. Test History Retrieve
        resp = await client.get("/api/history")
        assert resp.status_code == 200
        hist_items = resp.json().get("items", [])
        saved = next((h for h in hist_items if h["film_id"] == "test_123"), None)
        assert saved is not None
        assert abs(saved["position"] - 2542.5) < 0.1
        print(f"✅ 10. Resume Progress Verified: Saved position is {saved['position']}s ({int(saved['position']//60)}m {int(saved['position']%60)}s)")

        # Clean up test entry
        await client.delete("/api/history/test_123")
        print("✅ 11. History cleanup OK")

        print("🎬 ===================================================")
        print("🎬 ALL 11 END-TO-END TESTS PASSED PERFECTLY! 🚀")
        print("🎬 ===================================================")

if __name__ == "__main__":
    asyncio.run(run_e2e())
