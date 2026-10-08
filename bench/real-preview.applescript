-- Setup records a title as a second identity if AXDocument becomes unreadable.
-- An unreadable title refuses cleanup rather than confirming absence.
on fixtureMatches(w, wanted, fixtureTitle)
    tell application "System Events"
        set windowTitle to name of w
        try
            set documentURL to value of attribute "AXDocument" of w
        on error
            set documentURL to missing value
        end try
        if documentURL is wanted then return true
        if windowTitle is fixtureTitle or windowTitle starts with (fixtureTitle & " —") then
            if documentURL is not missing value and documentURL is not "" then error "Preview fixture title has a different document identity"
            return true
        end if
        if windowTitle contains fixtureTitle then error "Preview fixture title changed; cleanup unconfirmed"
    end tell
    return false
end fixtureMatches

on run argv
    set op to item 1 of argv
    set wanted to item 2 of argv
    set fixtureTitle to item 3 of argv
    repeat 20 times
        set matches to {}
        tell application "System Events" to tell process "Preview"
            repeat with w in windows
                if my fixtureMatches(w, wanted, fixtureTitle) then set end of matches to w
            end repeat
        end tell
        if (count matches) > 1 then error "Ambiguous Preview fixture windows"
        if op is "identify" then
            if (count matches) is 1 then
                tell application "System Events" to return name of item 1 of matches
            end if
            delay 0.2
        else
            exit repeat
        end if
    end repeat
    if op is "identify" then error "Preview fixture identity could not be established"
    tell application "System Events" to tell process "Preview"
        repeat with w in matches
            click (first button of w whose subrole is "AXCloseButton")
            delay 0.3
            if exists sheet 1 of w then
                set discardButtons to buttons of sheet 1 of w whose name is "Don’t Save" or name is "Don't Save"
                if (count discardButtons) is not 1 then error "Unexpected Preview sheet; cleanup stopped"
                click item 1 of discardButtons
            end if
        end repeat
        repeat with w in windows
            if my fixtureMatches(w, wanted, fixtureTitle) then error "Fixture Preview window is still open"
        end repeat
    end tell
end run
