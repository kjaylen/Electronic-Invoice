import Capacitor
import Foundation
import Network

/// Receipt printers for the till (web/src/pos/platform.ts, TillHardware): raw ESC/POS bytes to network
/// printers (port 9100) on the local network. Bluetooth receipt printers are an Android feature: most use
/// classic Bluetooth, which iOS apps cannot reach without the printer maker's MFi licence.
@objc(TillHardwarePlugin)
public class TillHardwarePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TillHardwarePlugin"
    public let jsName = "TillHardware"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sendNetwork", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listBluetooth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendBluetooth", returnType: CAPPluginReturnPromise),
    ]

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
