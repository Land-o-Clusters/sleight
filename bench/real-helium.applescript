-- Only the window created here is ever referenced. No tab or window inventory.
on run argv
    set op to item 1 of argv
    set fixtureURL to item 3 of argv
    tell application id "net.imput.helium"
        if op is "open" then
            set w to make new window
            set URL of active tab of w to fixtureURL
            return id of w
        else
            set wid to (item 4 of argv) as integer
            if exists window id wid then
                set w to window id wid
                if URL of active tab of w does not start with fixtureURL then error "Owned Helium window left the fixture; cleanup refused"
                close w
                if exists window id wid then error "Owned Helium window is still open"
            end if
        end if
    end tell
end run
