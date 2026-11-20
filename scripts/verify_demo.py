"""Verify the complete demo against a disposable instance of the Rust API."""

import argparse
import json
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4


def verify(base_url):
    def api(path, payload=None):
        request = Request(
            base_url.rstrip("/") + "/api/" + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    def guidance(category):
        query = urlencode({"station_id": "a", "category": category})
        return api("guidance?" + query)

    def sensor(status, observed_at=None, bin_id="a-recycle"):
        return {
            "event_id": str(uuid4()),
            "bin_id": bin_id,
            "status": status,
            "observed_at": time.time_ns() // 1_000_000 if observed_at is None else observed_at,
        }

    def active_tickets(state):
        return [ticket for ticket in state["tickets"] if ticket["status"] != "closed"]

    def active_ticket(state):
        tickets = active_tickets(state)
        assert len(tickets) == 1 and tickets[0]["bin_id"] == "a-recycle", tickets
        return tickets[0]

    api("demo/reset", {})
    try:
        result = api("recognize", {"mode": "replay", "sample": "bottle"})
        assert result["source"] == "replay", result
        category = result["category"]
        assert category == "recycle", result
        assert guidance(category)["action"] == "local"

        event = sensor("full")
        opened = api("sensor", event)
        ticket_id = active_ticket(opened)["id"]
        assert active_ticket(opened)["status"] == "pending"
        assert opened["recommendation"] == ticket_id
        assert active_ticket(api("sensor", event))["id"] == ticket_id
        time.sleep(0.02)
        assert active_ticket(api("sensor", sensor("full")))["id"] == ticket_id
        api("sensor", sensor("available", event["observed_at"] - 1))
        redirect = guidance(category)
        assert redirect["action"] == "redirect" and redirect["station_id"] != "a", redirect

        assert active_ticket(api(f"tickets/{ticket_id}/collect", {}))["status"] == "awaiting_verify"
        time.sleep(0.02)
        assert active_ticket(api("sensor", sensor("full")))["status"] == "needs_review"
        assert guidance(category)["action"] == "redirect"
        route = api(f"tickets/{ticket_id}/collect", {})
        assert active_ticket(route)["status"] == "awaiting_verify"
        time.sleep(0.02)
        complete = api("sensor", sensor("available"))
        assert not active_tickets(complete), complete
        assert guidance(category)["action"] == "local"

        api("sensor", sensor("unknown"))
        for station_id in ("b", "c"):
            api("sensor", sensor("unknown", bin_id=f"{station_id}-recycle"))
        assert guidance(category)["action"] == "wait"
        assert not active_tickets(api("state"))

        ambiguous = api("recognize", {"mode": "replay", "sample": "cup"})
        assert ambiguous["category"] is None and ambiguous["question"], ambiguous
        print("PASS: replay, full-bin reroute, duplicate/stale events, collection verification, unknown bins, clarification")
    finally:
        api("demo/reset", {})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Disposable demo instance URL; data is reset.")
    args = parser.parse_args()
    verify(args.base_url)
