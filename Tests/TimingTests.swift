import Testing

struct TimingTests {
  @Test func phasesOfOneNameAddUpInFirstRunOrder() {
    let timing = Timing()
    timing.add("events", .milliseconds(10))
    timing.add("press", .milliseconds(2))
    timing.add("events", .milliseconds(5))

    #expect(timing.finished.phases == [TimedPhase(name: "events", ms: 15, count: 2), TimedPhase(name: "press", ms: 2)])
  }

  @Test func lineCountsRepeatedPhases() {
    let timing = CommandTiming(totalMs: 412.4, phases: [TimedPhase(name: "queue", ms: 0.2), TimedPhase(name: "events", ms: 31.6, count: 2)])

    #expect(timing.line == "412 ms: queue 0, events 2x 32")
    #expect(CommandTiming(totalMs: 9, phases: []).line == "9 ms")
  }

  @Test func measureRecordsIntoTheCurrentTimingOnlyAndWhenWorkThrows() async {
    let timing = Timing()

    await Timing.measure("outside") {}
    await Timing.$current.withValue(timing) {
      await #expect(throws: Failure.self) { try await Timing.measure("locate") { throw Failure(.failed, "failed") } }
    }

    #expect(timing.finished.phases.map(\.name) == ["locate"])
  }
}
