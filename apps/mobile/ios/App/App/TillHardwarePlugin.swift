import Capacitor
import Foundation
import Network

/// Receipt printers for the till (web/src/pos/platform.ts, TillHardware): raw ESC/POS bytes to network
/// printers (port 9100) on the local network. Bluetooth receipt printers are an Android feature: most use
/// classic Bluetooth, which iOS apps cannot reach without the printer maker's MFi licence.
///
/// Also the till's secrets (its token, the key of its local data), in the Keychain, on this device only.
@objc(TillHardwarePlugin)
public class TillHardwarePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TillHardwarePlugin"
    public let jsName = "TillHardware"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sendNetwork", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listBluetooth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendBluetooth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretRemove", returnType: CAPPluginReturnPromise),
    ]

    // MARK: - secrets

    private let secretService = "bz.floreo.till.secrets"

    private func secretQuery(_ key: String) -> [String: Any] {
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: secretService, kSecAttrAccount as String: key]
    }

    @objc func secretSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("Missing the key or the value")
            return
        }
        SecItemDelete(secretQuery(key) as CFDictionary)
        var item = secretQuery(key)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecSuccess { call.resolve() } else { call.reject("Could not keep the secret (\(status))") }
    }

    @objc func secretGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing the key")
            return
        }
        var query = secretQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecSuccess, let data = found as? Data, let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
        } else {
            call.reject("Could not read the secret (\(status))")
        }
    }

    @objc func secretRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing the key")
            return
        }
        SecItemDelete(secretQuery(key) as CFDictionary)
        call.resolve()
    }

    /// One serial queue: every callback for a print runs here, one at a time.
    private let queue = DispatchQueue(label: "bz.floreo.till.printer")

    @objc func sendNetwork(_ call: CAPPluginCall) {
        guard let host = call.getString("host")?.trimmingCharacters(in: .whitespaces), !host.isEmpty,
              let base64 = call.getString("data"), let data = Data(base64Encoded: base64), !data.isEmpty else {
            call.reject("Missing the printer address or nothing to print")
            return
        }
        let port = call.getInt("port") ?? 9100
        guard (1...65535).contains(port), let endpointPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
            call.reject("Invalid printer port")
            return
        }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: .tcp)
        var finished = false
        let finish: (String?) -> Void = { error in
            if finished { return }
            finished = true
            connection.cancel()
            if let error = error { call.reject(error) } else { call.resolve() }
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                if let address = connection.currentPath?.remoteEndpoint, !TillHardwarePlugin.isLocal(address) {
                    finish("\(host) is not on the local network")
                    return
                }
                connection.send(content: data, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { error in
                    finish(error.map { "Could not print to \(host):\(port): \($0.localizedDescription)" })
                })
            case .failed(let error):
                finish("Could not reach the printer at \(host):\(port): \(error.localizedDescription)")
            case .waiting(let error):
                finish("No answer from the printer at \(host):\(port). Is it on and on this network? (\(error.localizedDescription))")
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 8) {
            finish("No answer from the printer at \(host):\(port). Is it on and on this network?")
        }
    }

    @objc func listBluetooth(_ call: CAPPluginCall) {
        call.reject("Bluetooth printers work with the Android app. On iPhone and iPad, use a network printer.")
    }

    @objc func sendBluetooth(_ call: CAPPluginCall) {
        listBluetooth(call)
    }

    /// 10/8, 172.16/12, 192.168/16, 169.254/16, loopback, and IPv6 local addresses.
    private static func isLocal(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let a):
            let b = [UInt8](a.rawValue)
            return b[0] == 10 || b[0] == 127 || (b[0] == 172 && (16...31).contains(b[1])) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254)
        case .ipv6(let a):
            return a.isLoopback || a.isLinkLocal || a.isUniqueLocal
        default:
            return false
        }
    }
}
