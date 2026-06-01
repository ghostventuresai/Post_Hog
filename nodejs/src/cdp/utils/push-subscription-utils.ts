import { EncryptedFields } from './encryption-utils'

/**
 * Extract the device token from the $device_push_subscription_<appIdentifier> person property.
 *
 * The property value is the encrypted device token
 * Returns the decrypted token, or null if the property is missing or decryption fails.
 */
export function getDevicePushSubscriptionToken(
    personProperties: Record<string, any> | undefined,
    appIdentifier: string,
    encryptedFields: EncryptedFields
): string | null {
    const value = personProperties?.[`$device_push_subscription_${appIdentifier}`]
    if (!value || typeof value !== 'string') {
        return null
    }

    return encryptedFields.decrypt(value, { ignoreDecryptionErrors: true }) ?? null
}
