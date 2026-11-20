"""Replay labelled full-bin episodes under two single-cleaner policies."""

import argparse
import csv
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class FullEvent:
    at_s: int
    bin_id: str

    @property
    def station(self):
        return self.bin_id.split("-", 1)[0]


class Cleaner:
    def __init__(self, events, config):
        self.remaining = list(events)
        self.completed = {}
        self.positions = config["positions"]
        self.station = "depot"
        self.now_s = 0
        self.walk_m = 0
        self.service_s = config["service_s"]
        self.meters_per_unit = config["meters_per_unit"]
        self.speed_m_per_s = config["speed_m_per_s"]

    def distance_to(self, station):
        here = self.positions[self.station]
        there = self.positions[station]
        return math.hypot(there[0] - here[0], there[1] - here[1])

    def walk_to(self, station):
        distance_m = self.distance_to(station) * self.meters_per_unit
        self.now_s += math.ceil(distance_m / self.speed_m_per_s)
        self.walk_m += distance_m
        self.station = station

    def arrived(self, station=None):
        return [
            event
            for event in self.remaining
            if event.at_s <= self.now_s and (station is None or event.station == station)
        ]

    def clear(self, event):
        assert event.station == self.station and event.at_s <= self.now_s
        self.now_s += self.service_s
        self.remaining.remove(event)
        if any(
            later.bin_id == event.bin_id and later.at_s < self.now_s
            for later in self.remaining
        ):
            raise ValueError(f"{event.bin_id} has overlapping full episodes")
        self.completed[event] = self.now_s - event.at_s


def fixed_patrol(events, config):
    cleaner = Cleaner(events, config)
    departure_s = 0
    while departure_s < config["horizon_s"] or cleaner.remaining:
        if departure_s >= cleaner.now_s:
            cleaner.now_s = departure_s
            for station in config["patrol_order"]:
                cleaner.walk_to(station)
                pending_here = cleaner.arrived(station)
                while pending_here:
                    cleaner.clear(min(pending_here, key=event_order))
                    pending_here = cleaner.arrived(station)
            cleaner.walk_to("depot")
        departure_s += config["patrol_interval_s"]
    return cleaner


def event_order(event):
    return event.at_s, event.bin_id


def on_demand(events, config):
    cleaner = Cleaner(events, config)
    while cleaner.remaining:
        cleaner.now_s = max(cleaner.now_s, min(event.at_s for event in cleaner.remaining))
        arrived = cleaner.arrived()
        oldest = min(event.at_s for event in arrived)
        near_ties = [event for event in arrived if event.at_s <= oldest + config["tie_s"]]
        target = min(
            near_ties,
            key=lambda event: (cleaner.distance_to(event.station), event_order(event)),
        )
        cleaner.walk_to(target.station)
        cleaner.clear(target)
    cleaner.now_s = max(cleaner.now_s, config["horizon_s"])
    cleaner.walk_to("depot")
    return cleaner


def metrics(scenario, policy, cleaner):
    waits = list(cleaner.completed.values())
    return {
        "scenario": scenario,
        "policy": policy,
        "full_episodes": len(waits),
        "total_full_wait_min": f"{sum(waits) / 60:.2f}",
        "mean_full_wait_min": f"{sum(waits) / len(waits) / 60:.2f}" if waits else "0.00",
        "max_full_wait_min": f"{max(waits, default=0) / 60:.2f}",
        "walked_m": f"{cleaner.walk_m:.2f}",
    }


def evaluate(fixture):
    config = fixture["config"]
    if sorted(config["patrol_order"]) != sorted(set(config["positions"]) - {"depot"}):
        raise ValueError("Patrol must visit every station exactly once per round")
    positive_config = ("patrol_interval_s", "speed_m_per_s", "meters_per_unit", "service_s", "horizon_s")
    if any(config[field] <= 0 for field in positive_config) or config["tie_s"] < 0:
        raise ValueError("Simulation parameters must be positive and tie_s nonnegative")
    for name, entries in fixture["scenarios"].items():
        events = [FullEvent(at_s, bin_id) for at_s, bin_id in entries]
        if len(set(events)) != len(events) or any(
            not 0 <= event.at_s < config["horizon_s"]
            or event.station not in config["patrol_order"]
            for event in events
        ):
            raise ValueError(f"Invalid fixture events: {name}")
        for policy in (fixed_patrol, on_demand):
            cleaner = policy(events, config)
            assert set(cleaner.completed) == set(events) and cleaner.station == "depot"
            yield metrics(name, policy.__name__, cleaner)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture", type=Path, default=Path(__file__).with_name("simulated_events.json")
    )
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    rows = list(evaluate(fixture))
    if rows:
        writer = csv.DictWriter(sys.stdout, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
