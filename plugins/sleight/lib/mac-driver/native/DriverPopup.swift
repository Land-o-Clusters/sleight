import Foundation

// Session provenance, independent of the cell's acted set. The parent still
// admits only numbers from a delivered, expanded, byte-equal menu subtree.
final class DriverPopupBank {
    struct Record {
        let window: String
        let root: DriverNode
        let owner: DriverNode
        let menu: DriverNode
        let sequence: UInt64
    }
    struct Input {
        let map: DriverReadMap
        let sequence: UInt64
    }
    private var records: [String: [Record]] = [:]
    private var pending: [String: Input] = [:]
    func began(_ map: DriverReadMap, window: String, sequence: UInt64) {
        pending[window] = Input(map: map, sequence: sequence)
    }
    func cancel(window: String) { pending.removeValue(forKey: window) }
    func observe(_ map: DriverReadMap, window: String, sequence: UInt64) throws {
        let input = pending.removeValue(forKey: window)
        guard !map.truncated else { records.removeValue(forKey: window); return }
        let menus = map.elements.values.filter { $0.role == "AXMenu" && $0.expanded && $0.root.same(map.root) }
        var kept = (records[window] ?? []).filter { record in
            record.root.same(map.root) && record.sequence == sequence && menus.contains { $0.node.same(record.menu) } &&
                map.elements.values.contains { $0.node.same(record.owner) }
        }
        if let input = input, !input.map.truncated, input.map.root.same(map.root), input.sequence == sequence {
            for menu in menus where !input.map.elements.values.contains(where: { $0.expanded && $0.node.same(menu.node) }) {
                guard let owner = menu.parent, let control = map.elements.values.first(where: { $0.node.same(owner) }),
                      !["AXMenu", "AXMenuItem", "AXMenuBar", "AXMenuBarItem", "AXWindow"].contains(control.role),
                      control.root.same(map.root), !control.secure else { continue }
                kept.append(Record(window: window, root: map.root, owner: owner, menu: menu.node, sequence: sequence))
            }
        }
        records[window] = kept
        if records.count > 16 { records = [window: kept] }
    }
    func record(menu: DriverNode, window: String, root: DriverNode, sequence: UInt64) -> Record? {
        (records[window] ?? []).first { $0.window == window && $0.root.same(root) && $0.menu.same(menu) && $0.sequence == sequence }
    }
}
