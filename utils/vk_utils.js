class VkUtils {
    static flattenFwdMessages = (fwd_messages) => {
        let result = [];
        for (const message of fwd_messages) {
            result.push(this.flattenFwdMessages(message.fwd_messages));
            result.push(message);
        }
        return result;
    };
}

module.exports = { VkUtils };