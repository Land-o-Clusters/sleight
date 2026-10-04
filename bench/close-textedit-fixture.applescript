on run argv
    set wanted to item 1 of argv
    tell application "TextEdit"
        set matches to {}
        repeat with d in documents
            try
                set documentPath to path of d
            on error
                set documentPath to missing value
            end try
            if documentPath is wanted then set end of matches to d
        end repeat
        repeat with d in matches
            close d saving no
        end repeat
        repeat with d in documents
            try
                set documentPath to path of d
            on error
                set documentPath to missing value
            end try
            if documentPath is wanted then error "Fixture document is still open"
        end repeat
    end tell
end run
