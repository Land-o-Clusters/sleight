on run argv
    set op to item 1 of argv
    set fixtureURL to item 3 of argv
    tell application "Safari"
        if op is "open" then
            make new document with properties {URL:fixtureURL}
            return id of front window
        else
            set wid to (item 4 of argv) as integer
            if exists window id wid then
                set w to window id wid
                if URL of current tab of w does not start with fixtureURL then error "Owned Safari window left the fixture; cleanup refused"
                close w
                if exists window id wid then error "Owned Safari window is still open"
            end if
        end if
    end tell
end run
