import CoreGraphics
import Testing

struct ScreenFitTests {
  // A 1512 x 982 primary with a menu bar, and a 1920 x 1080 screen to its right whose top is 98 points lower.
  let screens: [ScreenFit.Screen] = [
    (CGRect(x: 0, y: 0, width: 1512, height: 982), CGRect(x: 0, y: 0, width: 1512, height: 949)),
    (CGRect(x: 1512, y: -196, width: 1920, height: 1080), CGRect(x: 1512, y: -196, width: 1920, height: 1080)),
  ]

  @Test func picksTheScreenHoldingTheWindowCenter() throws {
    #expect(try ScreenFit.room(for: CSSRect(left: 100, top: 40, width: 800, height: 600), screens: screens) == screens[0].visible)
    #expect(try ScreenFit.room(for: CSSRect(left: 1600, top: 200, width: 800, height: 600), screens: screens) == screens[1].visible)
  }

  @Test func fallsBackToThePrimaryScreen() throws {
    #expect(try ScreenFit.room(for: nil, screens: screens) == screens[0].visible)
    #expect(try ScreenFit.room(for: CSSRect(left: -5000, top: 0, width: 800, height: 600), screens: screens) == screens[0].visible)
  }

  @Test func failsWithoutScreens() {
    #expect(throws: Failure.self) { try ScreenFit.room(for: nil, screens: []) }
  }
}
