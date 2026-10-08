-- Scoped native fixtures. Optional browsers have separate dictionaries.
on run argv
    set op to item 1 of argv
    set appID to item 2 of argv
    set fixtureTarget to item 3 of argv
    if appID is "simulator-viewer" then
        if fixtureTarget is not in {"DeviceHub", "Simulator"} then error "Unknown simulator viewer"
        tell application fixtureTarget to quit
    else if appID is "com.apple.calculator" then
        if op is "open" then
            if application "Calculator" is running then return "inherited"
            tell application "Calculator" to launch
            return "owned"
        else if item 4 of argv is "owned" then
            tell application "Calculator" to quit
        end if
    else if appID is "com.apple.finder" then
        tell application "Finder"
            if op is "open" then
                set w to make new Finder window to (POSIX file fixtureTarget)
                return id of w
            else
                set wid to (item 4 of argv) as integer
                if exists Finder window id wid then
                    set w to Finder window id wid
                    set currentPath to POSIX path of (target of w as alias)
                    if currentPath does not start with (fixtureTarget & "/") then error "Owned Finder window left the fixture; cleanup refused"
                    close w
                    if exists Finder window id wid then error "Owned Finder window is still open"
                end if
            end if
        end tell
    else if appID is "com.apple.TextEdit" then
        tell application "TextEdit"
            if op is "open" then
                open (POSIX file fixtureTarget)
            else
                close (every document whose path is fixtureTarget) saving no
                if exists (first document whose path is fixtureTarget) then error "Fixture TextEdit document is still open"
            end if
        end tell
    else
        error "Unknown fixture app"
    end if
end run
