## ADDED Requirements

### Requirement: Settings popup SHALL render as a fixed-position floating layer
The SettingsPopup component SHALL use `position: fixed` with the viewport as its positioning context, independent of any parent panel's width or overflow constraints.

#### Scenario: Popup width is independent of sidebar width
- **WHEN** the sidebar is 200px wide and the user opens settings
- **THEN** the settings popup SHALL be 340px wide, not constrained to 200px

#### Scenario: Popup is not clipped by sidebar overflow
- **WHEN** the sidebar has `overflow: hidden` and settings are opened
- **THEN** the popup SHALL render fully visible above all panels

### Requirement: Settings popup SHALL anchor to the gear button
The popup SHALL position itself relative to the ⚙ trigger button using `getBoundingClientRect()`, appearing above and right-aligned to the button.

#### Scenario: Popup appears above the gear button in expanded sidebar
- **WHEN** sidebar is expanded and user clicks the ⚙ button at the bottom
- **THEN** the popup SHALL appear above the button with 8px gap, right-aligned to the button's right edge

#### Scenario: Popup appears above the gear button in collapsed sidebar
- **WHEN** sidebar is collapsed to 40px and user clicks the ⚙ button
- **THEN** the popup SHALL appear above the button with 8px gap, right-aligned, at 340px width

#### Scenario: Popup stays within viewport bounds
- **WHEN** the gear button is near the top of the viewport
- **THEN** the popup SHALL fall back to appearing below the button (top: 8px) instead of being clipped above

### Requirement: Settings popup SHALL be rendered at Layout level
The `<SettingsPopup />` SHALL be rendered in `Layout.tsx` as a sibling of the three-panel flex container, not inside the Sidebar component.

#### Scenario: Sidebar no longer renders SettingsPopup
- **WHEN** the Sidebar component renders
- **THEN** it SHALL NOT contain a `<SettingsPopup />` element

#### Scenario: Layout renders SettingsPopup
- **WHEN** the Layout component renders on desktop
- **THEN** it SHALL include `<SettingsPopup />` as a direct child outside the flex container

### Requirement: Settings popup SHALL maintain existing close behaviors
The popup SHALL close when the user clicks outside it (excluding the gear toggle button) or presses Escape.

#### Scenario: Click outside closes popup
- **WHEN** the settings popup is open and the user clicks on the terminal area
- **THEN** the popup SHALL close

#### Scenario: Escape closes popup
- **WHEN** the settings popup is open and the user presses Escape
- **THEN** the popup SHALL close

#### Scenario: Clicking gear button toggles popup
- **WHEN** the settings popup is open and the user clicks the ⚙ button
- **THEN** the popup SHALL close (toggle behavior preserved)
