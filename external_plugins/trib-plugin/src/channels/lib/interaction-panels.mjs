const PANEL_COLOR = 5793266;
function actionRow(components) {
  return { type: 1, components };
}
function selectMenu(customId, placeholder, options) {
  return { type: 3, custom_id: customId, placeholder, options };
}
function button(style, label, customId) {
  return { type: 2, style, label, custom_id: customId };
}
function panel(title, description, components) {
  return {
    embeds: [{ title, description, color: PANEL_COLOR }],
    components
  };
}
function schedulePeriodOptions() {
  return [
    { label: "Daily", value: "daily" },
    { label: "Weekday", value: "weekday" },
    { label: "Hourly", value: "hourly" },
    { label: "Once", value: "once" }
  ];
}
function scheduleExecOptions() {
  return [
    { label: "Prompt (.md)", value: "prompt" },
    { label: "Script (.js/.py)", value: "script" },
    { label: "Script + Prompt", value: "script+prompt" }
  ];
}
function scheduleModeOptions() {
  return [
    { label: "Interactive", value: "interactive" },
    { label: "Non-interactive", value: "non-interactive" }
  ];
}
function buildScheduleAddPanel() {
  return panel("\u{1F4C5} Add Schedule", "Select options and press **Next**", [
    actionRow([selectMenu("sched_add_period", "Select Period", schedulePeriodOptions())]),
    actionRow([selectMenu("sched_add_exec", "Exec Mode", scheduleExecOptions())]),
    actionRow([selectMenu("sched_add_mode", "Mode", scheduleModeOptions())]),
    actionRow([
      button(1, "Next \u2192", "sched_add_next"),
      button(2, "\u2190 List", "bot_schedule"),
      button(4, "\u2715", "gui_close")
    ])
  ]);
}
function buildScheduleEditPanel(name) {
  return panel(`\u{1F4C4} ${name} Edit`, "Select options and press **Next**", [
    actionRow([selectMenu("sched_edit_period", "Select Period", schedulePeriodOptions())]),
    actionRow([selectMenu("sched_edit_exec", "Exec Mode", scheduleExecOptions())]),
    actionRow([selectMenu("sched_edit_mode", "Mode", scheduleModeOptions())]),
    actionRow([
      button(1, "Next \u2192", "sched_edit_next"),
      button(2, "\u2190 List", "bot_schedule"),
      button(4, "\u2715", "gui_close")
    ])
  ]);
}
function buildQuietHoursPanel() {
  return panel("\u{1F515} Quiet Hours", "Select holiday country and press **Next**", [
    actionRow([
      selectMenu("quiet_holidays_select", "Holiday Country (optional)", [
        { label: "None", value: "none" },
        { label: "\u{1F1F0}\u{1F1F7} Korea", value: "KR" },
        { label: "\u{1F1EF}\u{1F1F5} Japan", value: "JP" },
        { label: "\u{1F1FA}\u{1F1F8} USA", value: "US" },
        { label: "\u{1F1E8}\u{1F1F3} China", value: "CN" },
        { label: "\u{1F1EC}\u{1F1E7} UK", value: "GB" },
        { label: "\u{1F1E9}\u{1F1EA} Germany", value: "DE" }
      ])
    ]),
    actionRow([
      button(1, "Next \u2192", "quiet_set_next"),
      button(2, "\u2190 Quiet", "bot_quiet"),
      button(4, "\u2715", "gui_close")
    ])
  ]);
}
function buildActivityAddPanel() {
  return panel("\u{1F4E1} Add Activity Channel", "Select mode and press **Next**", [
    actionRow([
      selectMenu("activity_mode_select", "Select Mode", [
        { label: "Interactive \u2014 Participate", value: "interactive" },
        { label: "Monitor \u2014 Read-only", value: "monitor" }
      ])
    ]),
    actionRow([
      button(1, "Next \u2192", "activity_add_next"),
      button(2, "\u2190 Channels", "bot_activity"),
      button(4, "\u2715", "gui_close")
    ])
  ]);
}
export {
  buildActivityAddPanel,
  buildQuietHoursPanel,
  buildScheduleAddPanel,
  buildScheduleEditPanel
};
