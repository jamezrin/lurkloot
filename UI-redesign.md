# StreamMaxxing

The goal is to create a comprehensive and intuitive browser extension that can work with streaming platforms (as of now, Kick and Twitch).

The main functionalities are drop farming (from drop campaigns) and general watch time farming (of specific channels, which have an order for priority), to obtain channel points.

The extension uses browser tabs to perform these options and is transparent (but not hidden at all) for the user. 

We should use shadcn or other component libraries that might be useful. To fulfill these requirements, UI-wise there must be:

- There should be a minimal logo/name of the extension (the name is StreamMaxxing).
- A clear button to activate/disable the functionality, this should be scoped/work per streaming platform. Implemented in the popup settings.
- Some tabs or buttons for streaming platforms, featuring Twitch and Kick. These buttons should be like "tabs" and should have a clear indicator for when they are active or not, but a minimal one.
  - When switched to the tab of a platform, the background color and general accent of buttons and other UI elements should look like the general theme of the platform. Main colors: Twitch: `#6441A5`, Kick: `#53FC18`
  - Implemented in the popup with Twitch/Kick platform tabs and platform-specific accent colors.
- A button to get to a settings page. This settings page should be clearly sectioned for different features and platform-specific settings.
- Another tab control or whatever to switch from the drop campaigns and "Watch Queue" which is just watching favorite streamers to farm points.
  - Implemented in the popup with Drops and Watch Queue workflow tabs.
  - Drop campaigns should feature a well designed UI including all of the available info regarding that campaigns, such as the allowed channels for that drop, necessary time, obtained drops, remaining watch time (with percentage), and other information that might be available. Implemented with campaign status facts, account-link state, allowed-channel counts, end dates, reward progress, remaining minutes, and claim deadlines.
  - Watch time farming section should feature a scrollable and reorderable list of channels/streamers to watch. Implemented as ordered Watch Queue controls per platform in the popup.
